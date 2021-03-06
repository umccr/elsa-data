import * as edgedb from "edgedb";
import e from "../../../dbschema/edgeql-js";
import { AuthenticatedUser } from "../authenticated-user";
import { doRoleInReleaseCheck, getReleaseInfo } from "./helpers";
import { Base7807Error } from "../../api/errors/_error.types";
import { ReleaseDetailType } from "@umccr/elsa-types";
import { inject, injectable, Lifecycle, scoped, singleton } from "tsyringe";
import { differenceInSeconds } from "date-fns";
import { SelectService } from "./select-service";
import { ReleasesService } from "./releases-service";
import { UsersService } from "./users-service";
import { Transaction } from "edgedb/dist/transaction";

class NotAuthorisedToControlJob extends Base7807Error {
  constructor(userRole: string, releaseId: string) {
    super(
      "Not authorised to control jobs for this release",
      403,
      `User is only a ${userRole} in the release ${releaseId}`
    );
  }
}

@injectable()
@singleton()
export class JobsService {
  constructor(
    @inject("Database") private edgeDbClient: edgedb.Client,
    private usersService: UsersService,
    private releasesService: ReleasesService,
    private selectService: SelectService
  ) {}

  private async startGenericJob(
    releaseId: string,
    finalJobStartStep: (tx: Transaction) => Promise<void>
  ) {
    await this.edgeDbClient.transaction(async (tx) => {
      // we do not use the 'exclusive constraint's of edgedb because we want to
      // retain the link to the release - but with the constraint there is
      // only one *running* job per release - and exclusive constraints cannot have filters

      // so we need to check here inside a transaction to make sure that this
      // is the only running job for this release
      const oldJob = await e
        .select(e.job.Job, (j) => ({
          id: true,
          filter: e.op(
            e.op(j.status, "=", e.job.JobStatus.running),
            "and",
            e.op(j.forRelease.id, "=", e.uuid(releaseId))
          ),
        }))
        .run(tx);

      if (oldJob && oldJob.length > 0)
        throw new Base7807Error(
          "Only one running job is allowed per release",
          400,
          `Job with id(s) ${oldJob
            .map((oj) => oj.id)
            .join(" ")} have been found in the running state`
        );

      await finalJobStartStep(tx);
    });
  }

  /**
   * For a given release, start a background job identifying/selecting cases/patients/specimens
   * that should be included. Returns the release information which will now have
   * a 'runningJob' field.
   *
   * @param user
   * @param releaseId
   */
  public async startSelectJob(
    user: AuthenticatedUser,
    releaseId: string
  ): Promise<ReleaseDetailType> {
    const { userRole } = await doRoleInReleaseCheck(
      this.usersService,
      user,
      releaseId
    );

    if (userRole != "DataOwner")
      throw new NotAuthorisedToControlJob(userRole, releaseId);

    const { releaseQuery, releaseAllDatasetCasesQuery } = await getReleaseInfo(
      this.edgeDbClient,
      releaseId
    );

    await this.startGenericJob(releaseId, async (tx) => {
      // create a new select job entry
      await e
        .insert(e.job.SelectJob, {
          forRelease: releaseQuery,
          status: e.job.JobStatus.running,
          started: e.datetime_current(),
          percentDone: e.int16(0),
          messages: e.literal(e.array(e.str), ["Created"]),
          initialTodoCount: e.count(releaseAllDatasetCasesQuery),
          todoQueue: releaseAllDatasetCasesQuery,
          selectedSpecimens: e.set(),
        })
        .run(tx);
    });

    // return the status of the release - which now has a runningJob
    return await this.releasesService.getBase(releaseId, userRole);
  }

  public async cancelInProgressSelectJob(
    user: AuthenticatedUser,
    releaseId: string
  ): Promise<ReleaseDetailType> {
    const { userRole } = await doRoleInReleaseCheck(
      this.usersService,
      user,
      releaseId
    );

    if (userRole != "DataOwner")
      throw new NotAuthorisedToControlJob(userRole, releaseId);

    const { releaseQuery, releaseAllDatasetCasesQuery } = await getReleaseInfo(
      this.edgeDbClient,
      releaseId
    );

    await this.edgeDbClient.transaction(async (tx) => {
      const currentJob = await e
        .select(e.job.Job, (j) => ({
          id: true,
          filter: e.op(
            e.op(j.status, "=", e.job.JobStatus.running),
            "and",
            e.op(j.forRelease.id, "=", e.uuid(releaseId))
          ),
        }))
        .assert_single()
        .run(tx);

      if (!currentJob) throw new Error("No job yet");

      const x = await e
        .update(e.job.SelectJob, (sj) => ({
          filter: e.op(sj.id, "=", e.uuid(currentJob.id)),
          set: {
            requestedCancellation: true,
          },
        }))
        .run(tx);
    });

    // return the status of the release - which will not really have changed (because cancellations
    // take a while to happen)
    return await this.releasesService.getBase(releaseId, userRole);
  }

  /**
   * Return the ids for any 'select' jobs that are currently in progress.
   */
  public async getInProgressSelectJobs() {
    const jobsInProgress = await e
      .select(e.job.SelectJob, (sj) => ({
        id: true,
        forRelease: { id: true },
        requestedCancellation: true,
        filter: e.op(sj.status, "=", e.job.JobStatus.running),
      }))
      .run(this.edgeDbClient);

    return jobsInProgress.map((j) => ({
      jobId: j.id,
      releaseId: j.forRelease.id,
      requestedCancellation: j.requestedCancellation,
    }));
  }

  /**
   * Safely do a batch of work from the queue of work for the given
   * release.
   *
   * @param jobId
   * @param roughlyMaxSeconds roughly the number of seconds we should process items for (may exceed)
   */
  public async doSelectJobWork(
    jobId: string,
    roughlyMaxSeconds: number
  ): Promise<number> {
    const selectJobQuery = e
      .select(e.job.SelectJob, (j) => ({
        filter: e.op(j.id, "=", e.uuid(jobId)),
      }))
      .assert_single();

    if (!(await selectJobQuery.run(this.edgeDbClient)))
      throw new Error("Job id passed in was not a Select Job");

    const selectJobReleaseQuery = e.select(selectJobQuery.forRelease);

    const applicationCoded = await e
      .select(selectJobReleaseQuery.applicationCoded, (ac) => ({
        ...e.release.ApplicationCoded["*"],
      }))
      .run(this.edgeDbClient);

    const startTime = new Date();
    let processedCount = 0;

    // we want our job processing to be 'time' focussed... so do work until we roughly hit the
    // maximum time allotted
    while (differenceInSeconds(startTime, new Date()) < 10) {
      // we need to process a job off the queue - create the corresponding result (if any) - and save the result
      // we do this transactionally so we can never miss an item
      const c = await this.edgeDbClient.transaction(async (tx) => {
        const casesFromQueue = await e
          .select(selectJobQuery.todoQueue, (c) => ({
            ...e.dataset.DatasetCase["*"],
            dataset: {
              ...e.dataset.Dataset["*"],
            },
            patients: {
              ...e.dataset.DatasetPatient["*"],
              specimens: {
                ...e.dataset.DatasetSpecimen["*"],
              },
            },
            limit: 1,
          }))
          .run(tx);

        // todo: need to work out the magic of how EdgeDb wants us to type this kind of stuff...
        // (it can't be like this??)
        // edgedb.reflection.$expr_Literal<
        //           edgedb.reflection.ScalarType<"std::uuid", string, true, string>
        //         >
        const resultSpecimens: any[] = [];

        const resultMessages: string[] = [];

        // todo: get some messages back from the selection service
        resultMessages.push("Doing some work");

        for (const cas of casesFromQueue) {
          for (const pat of cas.patients || []) {
            for (const spec of pat.specimens || []) {
              if (
                await this.selectService.isSelectable(
                  applicationCoded as any,
                  cas as any,
                  pat as any,
                  spec as any
                )
              ) {
                resultSpecimens.push(e.uuid(spec.id));
              }
            }
          }
        }

        if (resultSpecimens.length > 0) {
          // get all the entries from the db corresponding to the specimens we chose
          const newResults = e.select(e.dataset.DatasetSpecimen, (ds) => ({
            filter: e.op(ds.id, "in", e.set(...resultSpecimens)),
          }));

          // we add those specimens that survived our consent logic into the selectSpecimens set
          const x = await e
            .update(e.job.SelectJob, (sj) => ({
              filter: e.op(sj.id, "=", e.uuid(jobId)),
              set: {
                selectedSpecimens: { "+=": newResults },
              },
            }))
            .run(tx);
        }

        // and we remove *all* the cases that we process as part of this batch from the todoQueue
        if (casesFromQueue.length > 0) {
          const doneCases = e.select(e.dataset.DatasetCase, (dc) => ({
            filter: e.op(
              dc.id,
              "in",
              e.set(...casesFromQueue.map((m) => e.uuid(m.id)))
            ),
          }));

          await e
            .update(e.job.SelectJob, (sj) => ({
              filter: e.op(sj.id, "=", e.uuid(jobId)),
              set: {
                // take off from the queue
                todoQueue: {
                  "-=": doneCases,
                },
                // append any new messages for the UI
                // TODO: make messages work
                // messages: e.op(sj.messages, "++", e.array(resultMessages)),
                // a crude calculation in the db of the percent done
                percentDone: e.cast(
                  e.int16,
                  e.math.floor(
                    e.op(
                      e.op(
                        e.op(
                          e.op(sj.initialTodoCount, "-", e.count(sj.todoQueue)),
                          "+",
                          casesFromQueue.length
                        ),
                        "*",
                        // so we actually don't want this percentDone to ever get us to 100%...
                        // that step is reserved for the final end job step
                        99.99
                      ),
                      "/",
                      sj.initialTodoCount
                    )
                  )
                ),
              },
            }))
            .run(tx);
        }
        processedCount += casesFromQueue.length;
        return casesFromQueue.length;
      });

      if (c === 0) break;
    }

    return processedCount;
  }

  /**
   * For a given release that involves a running 'select' job - finish
   * off the job.
   *
   * @param jobId
   * @param wasSuccessful
   * @param isCancellation
   */
  public async endSelectJob(
    jobId: string,
    wasSuccessful: boolean,
    isCancellation: boolean
  ): Promise<void> {
    // we need to move the new results into the release - and close this job off
    await this.edgeDbClient.transaction(async (tx) => {
      const selectJobQuery = e
        .select(e.job.SelectJob, (j) => ({
          filter: e.op(j.id, "=", e.uuid(jobId)),
        }))
        .assert_single();

      if (!selectJobQuery)
        throw new Error("Job id passed in was not a Select Job");

      if (!isCancellation) {
        const selectJobReleaseQuery = e.select(selectJobQuery.forRelease);

        // selectSpecimens from the job move straight over into the release selectedSpecimens
        // and blank out the runningJob (making the job now an orphan only gettable from getPreviousJob())
        if (wasSuccessful) {
          await e
            .update(selectJobReleaseQuery, (rq) => ({
              set: {
                selectedSpecimens: selectJobQuery.selectedSpecimens,
              },
            }))
            .run(tx);
        }
      }

      await e
        .update(selectJobQuery, (sj) => ({
          set: {
            percentDone: 100,
            ended: e.datetime_current(),
            status: isCancellation
              ? e.job.JobStatus.cancelled
              : wasSuccessful
              ? e.job.JobStatus.succeeded
              : e.job.JobStatus.failed,
          },
        }))
        .run(tx);
    });
  }

  /**
   * Return all the non-running jobs that have been associated with this release.
   *
   * @param releaseId
   */
  public async getPreviousJobs(releaseId: string) {
    return await e
      .select(e.job.Job, (sj) => ({
        filter: e.op(
          e.op(sj.status, "!=", e.job.JobStatus.running),
          "and",
          e.op(sj.forRelease.id, "=", e.uuid(releaseId))
        ),
      }))
      .run(this.edgeDbClient);
  }
}
