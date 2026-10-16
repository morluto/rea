import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { NeExecutableService } from "./NeExecutableService.js";
import { NE_EXECUTABLE_PROVIDER } from "../../domain/investigationProviders.js";
import { inspectNeExecutableInputSchema } from "../../domain/native/neExecutable.js";
import { parseNeExecutable } from "../../native/ne/NeExecutableParser.js";
import { neFixture } from "../../native/ne/NeExecutable.fixture.js";
import { ok } from "../../domain/result.js";
import { parseEvidence } from "../../domain/evidence.js";
import { fileIdentity } from "../../../tests/fixtures/evidenceSubject.js";

const observedReport = () => {
  const { bytes } = neFixture();
  return parseNeExecutable(
    bytes,
    {
      path: "/fixtures/sample.dll",
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    inspectNeExecutableInputSchema.parse({ path: "/fixtures/sample.dll" }),
  );
};

const service = (report: Awaited<ReturnType<typeof observedReport>>) =>
  new NeExecutableService({
    identity: NE_EXECUTABLE_PROVIDER,
    inspect: () => Promise.resolve(ok(report)),
  });

it("records observed Evidence for an NE subject", async () => {
  const report = await observedReport();
  const result = await service(report).inspect({
    path: "/fixtures/sample.dll",
  });
  if (!result.ok) throw new Error(result.error.message);
  const evidence = parseEvidence(result.value);
  expect(fileIdentity(evidence.subject)).toMatchObject({
    format: "ne",
    sha256: report.artifact.sha256,
  });
  expect(evidence).toMatchObject({
    operation: "inspect_ne_executable",
    confidence: "observed",
    normalized_result: report,
  });
});

it.each([
  "different-path",
  "outside-range",
  "wrong-coverage",
  "relocations-detached",
  "ordinal-order",
])(
  "rejects invalid provider output before creating Evidence: %s",
  async (problem) => {
    const report = await observedReport();
    if (problem === "different-path") report.artifact.path = "/other.dll";
    if (problem === "outside-range")
      report.resources[0]!.location.offset = report.artifact.bytes;
    if (problem === "wrong-coverage") report.coverage.examined_rows = 99;
    if (problem === "relocations-detached")
      report.segments[0]!.relocations!.location.offset += 2;
    if (problem === "ordinal-order") report.entries[1]!.ordinal = 1;
    expect(
      await service(report).inspect({ path: "/fixtures/sample.dll" }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
  },
);

it("rejects relative paths before reading", async () => {
  const report = await observedReport();
  expect(await service(report).inspect({ path: "sample.dll" })).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});
