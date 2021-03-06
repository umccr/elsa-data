import * as edgedb from "edgedb";
import e, { release } from "../../dbschema/edgeql-js";
import { ElsaSettings } from "../bootstrap-settings";
import {
  findSpecimenQuery,
  makeDoubleCodeArray,
  makeSingleCodeArray,
} from "./test-data-helpers";
import ApplicationCodedStudyType = release.ApplicationCodedStudyType;
import {
  BART_SPECIMEN,
  ELROY_SPECIMEN,
  HOMER_SPECIMEN,
  MARGE_SPECIMEN,
} from "./insert-test-data-10f";

const edgeDbClient = edgedb.createClient();

export async function insertRelease1(settings: ElsaSettings) {
  const mondoUri = "http://purl.obolibrary.org/obo/mondo.owl";

  return await e
    .insert(e.release.Release, {
      applicationDacTitle: "A Study of Lots of Test Data",
      applicationDacIdentifier: "ABC",
      applicationDacDetails: `
#### Origin

This is an application from REMS instance HGPP.

#### Purpose

We are going to take the test data and study it.

#### Ethics

Ethics form XYZ.

#### Other DAC application details

* Signed by A, B, C
* Agreed to condition Y
        `,
      applicationCoded: e.insert(e.release.ApplicationCoded, {
        studyType: ApplicationCodedStudyType.DS,
        countriesInvolved: makeSingleCodeArray("urn:iso:std:iso:3166", "AUS"),
        diseasesOfStudy: makeDoubleCodeArray(
          mondoUri,
          "MONDO:0008678",
          mondoUri,
          "MONDO:0021531"
        ),
        studyAgreesToPublish: true,
        studyIsNotCommercial: true,
      }),
      releaseIdentifier: "MNRETQER",
      releasePassword: "aeyePEWR", // pragma: allowlist secret
      releaseStarted: new Date(2022, 1, 23),
      datasetUris: e.array([
        "urn:fdc:umccr.org:2022:dataset/10g",
        "urn:fdc:umccr.org:2022:dataset/10f",
        "urn:fdc:umccr.org:2022:dataset/10c",
      ]),
      selectedSpecimens: e.set(
        // we fully select one trio
        findSpecimenQuery(BART_SPECIMEN),
        findSpecimenQuery(HOMER_SPECIMEN),
        findSpecimenQuery(MARGE_SPECIMEN),
        // and just the proband of another trio
        findSpecimenQuery(ELROY_SPECIMEN)
      ),
    })
    .run(edgeDbClient);
}
