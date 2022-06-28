import * as edgedb from "edgedb";
import e, { lab } from "../../dbschema/edgeql-js";
import {
  createArtifacts,
  makeEmptyIdentifierArray,
  makeSystemlessIdentifierArray,
  createFile,
  makeSystemlessIdentifier,
} from "./insert-test-data-helpers";

const edgeDbClient = edgedb.createClient();

export const TENF_URI = "urn:fdc:umccr.org:2022:dataset/10f";

/**
 * The 10F dataset is a subset of the 1000 genomes data with a combination of more complex
 * families.
 */
export async function insert10F() {
  const makeArtifacts = async (specimenId: string) => {
    return await createArtifacts(
      createFile(
        `s3://umccr-10f-data-dev/${specimenId}/${specimenId}.hard-filtered.vcf.gz`,
        56456456,
        "NOTREAL"
      ),
      createFile(
        `s3://umccr-10f-data-dev/${specimenId}/${specimenId}.hard-filtered.vcf.gz.tbi`,
        56546
      ),
      createFile(
        `s3://umccr-10f-data-dev/${specimenId}/${specimenId}.bam`,
        123534530,
        "NOT",
        "MD5"
      ),
      createFile(
        `s3://umccr-10f-data-dev/${specimenId}/${specimenId}.bam.bai`,
        3424
      ),
      []
    );
  };

  const makeTrio = async (
    familyId: string,
    probandPatientId: string,
    probandSpecimenId: string,
    probandSex: "male" | "female" | "other",
    fatherPatientId: string,
    fatherSpecimenId: string,
    motherPatientId: string,
    motherSpecimenId: string
  ) => {
    return e.insert(e.dataset.DatasetCase, {
      externalIdentifiers: makeSystemlessIdentifierArray(familyId),
      patients: e.set(
        e.insert(e.dataset.DatasetPatient, {
          sexAtBirth: probandSex,
          externalIdentifiers: makeSystemlessIdentifierArray(probandPatientId),
          specimens: e.insert(e.dataset.DatasetSpecimen, {
            externalIdentifiers:
              makeSystemlessIdentifierArray(probandSpecimenId),
            artifacts: await makeArtifacts(probandSpecimenId),
          }),
        }),
        e.insert(e.dataset.DatasetPatient, {
          sexAtBirth: "male",
          externalIdentifiers: makeSystemlessIdentifierArray(fatherPatientId),
          specimens: e.insert(e.dataset.DatasetSpecimen, {
            externalIdentifiers:
              makeSystemlessIdentifierArray(fatherSpecimenId),
            artifacts: await makeArtifacts(fatherSpecimenId),
          }),
        }),
        e.insert(e.dataset.DatasetPatient, {
          sexAtBirth: "female",
          externalIdentifiers: makeSystemlessIdentifierArray(motherPatientId),
          specimens: e.insert(e.dataset.DatasetSpecimen, {
            externalIdentifiers:
              makeSystemlessIdentifierArray(motherSpecimenId),
            artifacts: await makeArtifacts(motherSpecimenId),
          }),
        })
      ),
    });
  };

  const addPatient = async (
    familyId: string,
    patientId: string,
    specimenId: string,
    sex: "male" | "female" | "other"
  ) => {
    const arts = await makeArtifacts(specimenId);
    await e
      .update(e.dataset.DatasetCase, (dc) => ({
        filter: e.op(
          makeSystemlessIdentifier(familyId),
          "in",
          e.set(e.array_unpack(dc.externalIdentifiers))
        ),
        set: {
          patients: {
            "+=": e.insert(e.dataset.DatasetPatient, {
              sexAtBirth: sex,
              externalIdentifiers: makeSystemlessIdentifierArray(patientId),
              specimens: e.insert(e.dataset.DatasetSpecimen, {
                externalIdentifiers: makeSystemlessIdentifierArray(specimenId),
                artifacts: arts,
              }),
            }),
          },
        },
      }))
      .run(edgeDbClient);
  };

  const deletePatient = async (patientId: string) => {
    await e
      .delete(e.dataset.DatasetPatient, (dp) => ({
        filter: e.op(
          makeSystemlessIdentifier(patientId),
          "in",
          e.set(e.array_unpack(dp.externalIdentifiers))
        ),
      }))
      .run(edgeDbClient);
  };

  const tenf = await e
    .insert(e.dataset.Dataset, {
      uri: TENF_URI,
      externalIdentifiers: makeSystemlessIdentifierArray("10F"),
      description: "UMCCR 10F",
      cases: e.set(
        await makeTrio(
          "SIMPSONS",
          "TRIOLISA",
          "HG1",
          "female",
          "TRIOHOMER",
          "HG2",
          "TRIOMARGE",
          "HG3"
        ),
        await makeTrio(
          "JETSONS",
          "TRIOELROY",
          "HG4",
          "male",
          "TRIOGEORGE",
          "HG5",
          "TRIOJUDY",
          "HG6"
        ),
        // convert this to a full family at some point
        await makeTrio(
          "ADDAMS",
          "QUINWEDNESDAY",
          "HG7",
          "female",
          "QUINGGOMEZ",
          "HG8",
          "QUINMORTICIA",
          "HG9"
          // PUGSLEY
          // UNCLE FESTER - brother of GOMEZ
          // Esmeralda ADDAMS (Grandmama) - mother of MORITICIA
          // COUSIN ITT
        ),
        // convert this to a full family at some point
        await makeTrio(
          "DUCK",
          "DONALD",
          "HG90",
          "male",
          "UNKNOWNDUCK",
          "HG92",
          "DELLA",
          "HG91"
          // DELLA and DONALD are twins
          // DELLA is mother of
          // HUEY, DEWEY and LOUIE (triplets)
          // SCROOGE in there too
          // DAISY DUCK .. girlfield to donald
        )
      ),
    })
    .run(edgeDbClient);

  // add in some extras to the 'beyond trio' families
  await addPatient("DUCK", "HUEY", "HG93", "male");
  await addPatient("DUCK", "DEWEY", "HG94", "male");
  await addPatient("DUCK", "LOUIE", "HG95", "male");
  await addPatient("DUCK", "SCROOGE", "HG96", "male");
  await addPatient("DUCK", "DAISY", "HG97", "female");
  // we actually want a complex family with no father - so we delete this placeholder duck
  await deletePatient("UNKNOWNDUCK");
}