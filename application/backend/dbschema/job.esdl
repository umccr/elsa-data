module job {

    scalar type JobStatus extending enum<'running', 'succeeded', 'failed', 'cancelled'>;

    abstract type Job {

        # a compulsory link to the release that this job is run on behalf of
        #
        required link forRelease -> release::Release {
            # releases cannot be deleted while a job is present (revisit?)
            on target delete restrict;
        }

        # the status of the job
        #
        required property status -> JobStatus;

        # the database time the job was created
        #
        required property created -> datetime {
            default := datetime_current();
            readonly := true;
        };

        # the database time the job was first accessed for processing by a job worker
        #
        required property started -> datetime;

        # set to true to pass down to the workers a desire for cancellation
        #
        required property requestedCancellation -> bool {
            default := false;
        }

        # the job service estimation of the percentage done for UI display
        #
        required property percentDone -> int16 {
          constraint min_value(0);
          constraint max_value(100);
        }

        # a log of messages that can be display in the UI
        #
        required property messages -> array<str>;

        # the database time this job ended with either success, failure or cancellation
        #
        optional property ended -> datetime;
    }

    # the premise here is a job that can gradually work through each case in the to do
    # set and if matching move the result to the result set

    type SelectJob extending Job {

        required property initialTodoCount -> int32;

        multi link todoQueue -> dataset::DatasetCase {
            on target delete allow;
        };

        multi link selectedSpecimens -> dataset::DatasetSpecimen {
            on target delete allow;
        };


    }
}
