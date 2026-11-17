import { expect, it } from "vitest";
import { ParseFailureError } from "../domain/parseFailure.js";
import { MavenGradleUnresolvedCollector } from "./MavenGradleUnresolvedCollector.js";

it("admits distinct references before retaining them and stops at a small shared quota", () => {
  const collector = new MavenGradleUnresolvedCollector(2);
  let failure: unknown;
  try {
    collector.properties(
      [["version", "${first}${first}${second}${third}${fourth}"]],
      "project",
      null,
    );
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(ParseFailureError);
  expect(failure).toMatchObject({
    failure: {
      kind: "limit",
      limit: { name: "unresolved_records", maximum: 2, required: 3 },
    },
  });
  expect(collector.finish()).toEqual([
    {
      kind: "property",
      reference: "${first}",
      field: "version",
      owner: "project",
      index: null,
    },
    {
      kind: "property",
      reference: "${second}",
      field: "version",
      owner: "project",
      index: null,
    },
  ]);
});

it("deduplicates within each field while preserving separate field and row facts", () => {
  const collector = new MavenGradleUnresolvedCollector(3);
  collector.properties(
    [
      ["version", "${same}${same}"],
      ["scope", "${same}"],
    ],
    "dependency",
    0,
  );
  collector.properties([["version", "${same}"]], "dependency", 1);
  expect(
    collector
      .finish()
      .map(({ field, index, reference }) => ({ field, index, reference })),
  ).toEqual([
    { field: "version", index: 0, reference: "${same}" },
    { field: "scope", index: 0, reference: "${same}" },
    { field: "version", index: 1, reference: "${same}" },
  ]);
});

it("shares admission between coordinate gaps and references across calls", () => {
  const collector = new MavenGradleUnresolvedCollector(2);
  collector.coordinates(
    { group_id: null, artifact_id: null, version: "1" },
    "project",
    null,
    false,
  );
  expect(() =>
    collector.properties([["scope", "${scope}"]], "dependency", 0),
  ).toThrow(ParseFailureError);
  expect(
    collector.finish().map(({ kind, reference }) => ({ kind, reference })),
  ).toEqual([
    { kind: "missing-coordinate", reference: "project.group_id" },
    { kind: "missing-coordinate", reference: "project.artifact_id" },
  ]);
});
