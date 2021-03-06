import * as edgedb from "edgedb";
import e, { dataset } from "../../../dbschema/edgeql-js";
import {
  ReleaseCaseType,
  ReleaseDetailType,
  ReleaseNodeStatusType,
  ReleasePatientType,
  ReleaseSpecimenType,
  ReleaseSummaryType,
} from "@umccr/elsa-types";
import { AuthenticatedUser } from "../authenticated-user";
import { isObjectLike, isSafeInteger } from "lodash";
import { createPagedResult, PagedResult } from "../../api/api-pagination";
import {
  collapseExternalIds,
  doRoleInReleaseCheck,
  getReleaseInfo,
} from "./helpers";
import { inject, injectable, singleton } from "tsyringe";
import { UsersService } from "./users-service";
import { ReleaseBaseService } from "./release-base-service";

// an internal string set that tells the service which generic field to alter
// (this allows us to make a mega function that sets all array fields in the same way)
type CodeArrayFields = "diseases" | "countries" | "type";

@injectable()
export class ReleasesService extends ReleaseBaseService {
  constructor(
    @inject("Database") edgeDbClient: edgedb.Client,
    usersService: UsersService
  ) {
    super(edgeDbClient, usersService);
  }

  public async getAll(
    user: AuthenticatedUser,
    limit: number,
    offset: number
  ): Promise<ReleaseSummaryType[]> {
    const allForUser = await e
      .select(e.release.Release, (r) => ({
        ...e.release.Release["*"],
        runningJob: {
          percentDone: true,
        },
        userRoles: e.select(
          r["<releaseParticipant[is permission::User]"],
          (u) => ({
            id: true,
            filter: e.op(u.id, "=", e.uuid(user.dbId)),
            // "@role": true
          })
        ),
      }))
      .run(this.edgeDbClient);

    return allForUser
      .filter((a) => a.userRoles != null)
      .map((a) => ({
        id: a.id,
        datasetUris: a.datasetUris,
        applicationDacIdentifier:
          a?.applicationDacIdentifier ?? "<unidentified>",
        applicationDacTitle: a?.applicationDacTitle ?? "<untitled>",
        isRunningJobPercentDone: undefined,
      }));
  }

  /**
   * Get a single release.
   *
   * @param user
   * @param releaseId
   */
  public async get(
    user: AuthenticatedUser,
    releaseId: string
  ): Promise<ReleaseDetailType | null> {
    const { userRole } = await doRoleInReleaseCheck(
      this.usersService,
      user,
      releaseId
    );

    return this.getBase(releaseId, userRole);
  }

  /**
   * Get the password of a single release.
   * Note: this is not a super secret secret - this is just to add a light layer of
   * protection to artifacts/manifest downloaded from Elsa.
   *
   * @param user
   * @param releaseId
   */
  public async getPassword(
    user: AuthenticatedUser,
    releaseId: string
  ): Promise<string | null> {
    const { userRole } = await doRoleInReleaseCheck(
      this.usersService,
      user,
      releaseId
    );

    const { releaseInfo } = await getReleaseInfo(this.edgeDbClient, releaseId);

    return releaseInfo.releasePassword;
  }

  /**
   * Get all the cases for a release including checkbox status down to specimen level.
   *
   * Depending on the role of the user this will return different sets of cases.
   * (the admins will get all the cases, but researchers/pi will only see cases that they
   * have some level of visibility into)
   *
   * @param user
   * @param releaseId
   * @param limit
   * @param offset
   */
  public async getCases(
    user: AuthenticatedUser,
    releaseId: string,
    limit: number,
    offset: number
  ): Promise<PagedResult<ReleaseCaseType> | null> {
    const { userRole } = await doRoleInReleaseCheck(
      this.usersService,
      user,
      releaseId
    );

    const {
      releaseAllDatasetCasesQuery,
      releaseSelectedSpecimensQuery,
      releaseSelectedCasesQuery,
      datasetUriToIdMap,
    } = await getReleaseInfo(this.edgeDbClient, releaseId);

    const datasetIdSet =
      datasetUriToIdMap.size > 0
        ? e.set(...datasetUriToIdMap.values())
        : e.cast(e.uuid, e.set());

    const makeFilter = (dsc: any) => {
      return e.op(
        e.op(dsc.dataset.id, "in", datasetIdSet),
        "and",
        e.op(
          e.bool(userRole === "DataOwner"),
          "or",
          e.op(dsc.patients.specimens, "in", releaseSelectedSpecimensQuery)
        )
      );
    };

    const caseSearchQuery = e.select(e.dataset.DatasetCase, (dsc) => ({
      ...e.dataset.DatasetCase["*"],
      dataset: {
        ...e.dataset.Dataset["*"],
      },
      patients: (p) => ({
        ...e.dataset.DatasetPatient["*"],
        consent: true,
        filter: e.op(
          e.bool(userRole === "DataOwner"),
          "or",
          e.op(p.specimens, "in", releaseSelectedSpecimensQuery)
        ),
        specimens: (s) => ({
          ...e.dataset.DatasetSpecimen["*"],
          consent: true,
          isSelected: e.op(s, "in", releaseSelectedSpecimensQuery),
          filter: e.op(
            e.bool(userRole === "DataOwner"),
            "or",
            e.op(s, "in", releaseSelectedSpecimensQuery)
          ),
        }),
      }),
      // our cases should only be those from the datasets of this release and those appropriate for the user
      filter: makeFilter(dsc),
      // paging
      limit: isSafeInteger(limit) ? e.int64(limit!) : undefined,
      offset: isSafeInteger(offset) ? e.int64(offset!) : undefined,
      order_by: [
        {
          expression: dsc.dataset.uri,
          direction: e.ASC,
        },
        {
          expression: dsc.id,
          direction: e.ASC,
        },
      ],
    }));

    const pageCases = await caseSearchQuery.run(this.edgeDbClient);

    // we need to construct the result hierarchies, including computing the checkbox at intermediate nodes

    if (!pageCases) return null;

    //const casesCount =
    //  userRole === "DataOwner"
    //    ? await e.count(releaseAllDatasetCasesQuery).run(this.edgeDbClient)
    //    : await e.count(releaseSelectedCasesQuery).run(this.edgeDbClient);

    // given an array of children node-like structures, compute what our node status is
    // NOTE: this is entirely dependent on the Release node types to all have a `nodeStatus` field
    const calcNodeStatus = (
      nodes: { nodeStatus: ReleaseNodeStatusType }[]
    ): ReleaseNodeStatusType => {
      const isAllSelected = nodes.every((s) => s.nodeStatus === "selected");
      const isNoneSelected = nodes.every((s) => s.nodeStatus === "unselected");
      return (
        isAllSelected
          ? "selected"
          : isNoneSelected
          ? "unselected"
          : "indeterminate"
      ) as ReleaseNodeStatusType;
    };

    const createSpecimenMap = (
      spec: dataset.DatasetSpecimen
    ): ReleaseSpecimenType => {
      return {
        id: spec.id,
        externalId: collapseExternalIds(spec.externalIdentifiers),
        nodeStatus: ((spec as any).isSelected
          ? "selected"
          : "unselected") as ReleaseNodeStatusType,
        customConsent: isObjectLike(spec.consent),
      };
    };

    const createPatientMap = (
      pat: dataset.DatasetPatient
    ): ReleasePatientType => {
      const specimensMapped = Array.from<ReleaseSpecimenType>(
        pat.specimens.map(createSpecimenMap)
      );

      return {
        id: pat.id,
        sexAtBirth: pat?.sexAtBirth || undefined,
        externalId: collapseExternalIds(pat.externalIdentifiers),
        nodeStatus: calcNodeStatus(specimensMapped),
        customConsent: isObjectLike(pat.consent),
        specimens: specimensMapped,
      };
    };

    const createCaseMap = (cas: dataset.DatasetCase): ReleaseCaseType => {
      const patientsMapped = Array.from<ReleasePatientType>(
        cas.patients.map(createPatientMap)
      );

      return {
        id: cas.id,
        externalId: collapseExternalIds(cas.externalIdentifiers),
        fromDatasetId: cas.dataset?.id!,
        fromDatasetUri: cas.dataset?.uri!,
        nodeStatus: calcNodeStatus(patientsMapped),
        customConsent: isObjectLike(cas.consent),
        patients: patientsMapped,
      };
    };

    // TODO: remove the paged result from this
    return createPagedResult(
      pageCases.map((pc) =>
        createCaseMap(pc as unknown as dataset.DatasetCase)
      ),
      1000,
      limit
    );
  }

  public async setMasterAccess(
    user: AuthenticatedUser,
    releaseId: string,
    start?: Date,
    end?: Date
  ): Promise<void> {}

  public async setSelected(
    user: AuthenticatedUser,
    releaseId: string,
    specimenIds: string[]
  ): Promise<any | null> {
    return await this.setSelectedStatus(user, releaseId, specimenIds, true);
  }

  public async setUnselected(
    user: AuthenticatedUser,
    releaseId: string,
    specimenIds: string[]
  ): Promise<any | null> {
    return await this.setSelectedStatus(user, releaseId, specimenIds, false);
  }

  public async addDiseaseToApplicationCoded(
    user: AuthenticatedUser,
    releaseId: string,
    system: string,
    code: string
  ): Promise<ReleaseDetailType> {
    const { userRole } = await doRoleInReleaseCheck(
      this.usersService,
      user,
      releaseId
    );

    await this.alterApplicationCodedArrayEntry(
      userRole,
      releaseId,
      "diseases",
      system,
      code,
      false
    );

    return await this.getBase(releaseId, userRole);
  }

  public async removeDiseaseFromApplicationCoded(
    user: AuthenticatedUser,
    releaseId: string,
    system: string,
    code: string
  ): Promise<ReleaseDetailType> {
    const { userRole } = await doRoleInReleaseCheck(
      this.usersService,
      user,
      releaseId
    );

    await this.alterApplicationCodedArrayEntry(
      userRole,
      releaseId,
      "diseases",
      system,
      code,
      true
    );

    return await this.getBase(releaseId, userRole);
  }

  public async addCountryToApplicationCoded(
    user: AuthenticatedUser,
    releaseId: string,
    system: string,
    code: string
  ): Promise<ReleaseDetailType> {
    const { userRole } = await doRoleInReleaseCheck(
      this.usersService,
      user,
      releaseId
    );

    await this.alterApplicationCodedArrayEntry(
      userRole,
      releaseId,
      "countries",
      system,
      code,
      false
    );

    return await this.getBase(releaseId, userRole);
  }

  public async removeCountryFromApplicationCoded(
    user: AuthenticatedUser,
    releaseId: string,
    system: string,
    code: string
  ): Promise<ReleaseDetailType> {
    const { userRole } = await doRoleInReleaseCheck(
      this.usersService,
      user,
      releaseId
    );

    await this.alterApplicationCodedArrayEntry(
      userRole,
      releaseId,
      "countries",
      system,
      code,
      true
    );

    return await this.getBase(releaseId, userRole);
  }

  public async setTypeOfApplicationCoded(
    user: AuthenticatedUser,
    releaseId: string,
    type: "HMB" | "DS" | "CC" | "GRU" | "POA"
  ): Promise<ReleaseDetailType> {
    const { userRole } = await doRoleInReleaseCheck(
      this.usersService,
      user,
      releaseId
    );

    await this.edgeDbClient.transaction(async (tx) => {
      // get the current coded application
      const releaseWithAppCoded = await e
        .select(e.release.Release, (r) => ({
          applicationCoded: {
            id: true,
            studyType: true,
            countriesInvolved: true,
            diseasesOfStudy: true,
          },
          filter: e.op(r.id, "=", e.uuid(releaseId)),
        }))
        .assert_single()
        .run(tx);

      if (!releaseWithAppCoded)
        throw new Error(
          `Release ${releaseId} that existed just before this code has now disappeared!`
        );

      await e
        .update(e.release.ApplicationCoded, (ac) => ({
          filter: e.op(
            ac.id,
            "=",
            e.uuid(releaseWithAppCoded.applicationCoded.id)
          ),
          set: {
            studyType: type,
          },
        }))
        .run(tx);
    });

    return await this.getBase(releaseId, userRole);
  }
}
