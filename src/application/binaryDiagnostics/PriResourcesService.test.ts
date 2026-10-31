import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { PriResourcesService } from "./PriResourcesService.js";
import { PRI_RESOURCES_PROVIDER } from "../../domain/investigationProviders.js";
import {
  inspectPriResourcesInputSchema,
  type PriResources,
} from "../../domain/native/priResources.js";
import { parsePriResources } from "../../native/pri/PriResourceParser.js";
import { priFixture } from "../../native/pri/PriResources.fixture.js";
import { ok } from "../../domain/result.js";

const PATH = "/fixtures/resources.pri";

const observedReport = (selection: Record<string, unknown>) => {
  const { bytes } = priFixture();
  return parsePriResources(
    bytes,
    {
      path: PATH,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    inspectPriResourcesInputSchema.parse({ path: PATH, ...selection }),
  );
};

const serviceReturning = (report: PriResources) =>
  new PriResourcesService({
    identity: PRI_RESOURCES_PROVIDER,
    inspect: () => Promise.resolve(ok(report)),
  });

it.each<[string, Record<string, unknown>, (report: PriResources) => void]>([
  [
    "different path",
    {},
    (report) => void (report.artifact.path = "/other.pri"),
  ],
  [
    "location outside the artifact",
    { collection: "candidates" },
    (report) => {
      const row =
        report.page.collection === "candidates"
          ? report.page.candidates[0]
          : undefined;
      if (row?.source.kind === "data-item")
        row.source.location.offset = report.artifact.bytes;
    },
  ],
  ["wrong coverage", {}, (report) => void (report.coverage.candidates = 99)],
  [
    "inconsistent continuation",
    { limit: 2 },
    (report) => void (report.page.next_offset = null),
  ],
  [
    "a different collection",
    { collection: "items" },
    (report) =>
      void (report.page = {
        ...report.page,
        collection: "sections",
        sections: [],
        returned: 0,
      }),
  ],
  [
    "rows outside the name selection",
    { names: ["Resources/AppDisplayName"] },
    (report) => {
      if (report.page.collection === "items" && report.page.items[0])
        report.page.items[0].name = "Resources/Other";
    },
  ],
  [
    "rows outside the qualifier selection",
    {
      collection: "candidates",
      qualifiers: [{ name: "Language", value: "en-US" }],
    },
    (report) => {
      if (report.page.collection === "candidates" && report.page.candidates[0])
        report.page.candidates[0].qualifiers = [];
    },
  ],
])(
  "rejects provider output with %s before creating Evidence",
  async (_problem, selection, mutate) => {
    const report = await observedReport(selection);
    // The unchanged observation is accepted, so the rejection comes from the mutation.
    const accepted = await serviceReturning(structuredClone(report)).inspect({
      path: PATH,
      ...selection,
    });
    if (!accepted.ok) throw accepted.error;
    mutate(report);
    expect(
      await serviceReturning(report).inspect({ path: PATH, ...selection }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
  },
);

it("creates file Evidence that preserves the caller's selection", async () => {
  const selection = {
    collection: "candidates",
    query: "resources/",
    qualifiers: [{ name: "Language", value: "en-US" }],
  };
  const result = await serviceReturning(
    await observedReport(selection),
  ).inspect({ path: PATH, ...selection });
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    subject: { format: "file", local_path: PATH },
    provider: { id: "rea-pri-resources" },
    operation: "inspect_pri_resources",
    parameters: {
      path: PATH,
      collection: "candidates",
      query: "resources/",
      qualifiers: [{ name: "Language", value: "en-US" }],
      offset: 0,
      limit: 100,
      max_file_bytes: 67108864,
    },
    confidence: "observed",
  });
  expect(result.value.parameters).not.toHaveProperty("names");
});

it.each([
  [{ path: "relative.pri" }, ["path"]],
  [{ path: PATH, collection: "sections", names: ["Resources/A"] }, ["names"]],
  [
    {
      path: PATH,
      collection: "qualifiers",
      value_types: ["String"],
    },
    ["value_types"],
  ],
  [{ path: PATH, limit: 1001 }, ["limit"]],
])("rejects caller input %j before reading the file", async (input, path) => {
  let read = false;
  const service = new PriResourcesService({
    identity: PRI_RESOURCES_PROVIDER,
    inspect: () => {
      read = true;
      return Promise.reject(new Error("unexpected read"));
    },
  });
  expect(await service.inspect(input)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError", issues: [{ path }] },
  });
  expect(read).toBe(false);
});

it("discards an observation if the caller cancels while the provider completes", async () => {
  const report = await observedReport({});
  const controller = new AbortController();
  const service = new PriResourcesService({
    identity: PRI_RESOURCES_PROVIDER,
    inspect: () => {
      controller.abort();
      return Promise.resolve(ok(report));
    },
  });
  expect(
    await service.inspect({ path: PATH }, { signal: controller.signal }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
});
