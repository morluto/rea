import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import type { UndeliveredSourceClosure } from "../../../src/application/AnalysisEvidenceSources.js";
import { runDirectAnalysis } from "../../../src/application/DirectAnalysis.js";
import {
  deliverCliAnalysisEvidence,
  publishCliAnalysisEvidence,
} from "../../../src/cli/analysisEvidenceDelivery.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
} from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createArtifactInspection } from "../../../src/domain/artifactInspection.js";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../../src/domain/evidence.js";
import { jsonByteLength } from "../../../src/domain/jsonSerialization.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err, ok } from "../../../src/domain/result.js";
import { OwnedStagedOutput } from "../../../src/filesystem/OwnedStagedOutput.js";
import { inventoryArtifact } from "../../fixtures/artifactInventory.js";
import { composedWorkflowFixture } from "../../fixtures/composedWorkflowEvidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };

const source = (name: string, links: readonly string[] = []) =>
  createEvidence(undefined, provider, {
    operation: "fixture_source",
    parameters: { name },
    result: { name },
    evidenceLinks: [...links],
  });

const observed = (links: readonly string[]) =>
  createEvidence(undefined, provider, {
    operation: "fixture_observation",
    parameters: {},
    result: { completed: true },
    evidenceLinks: [...links],
  });

const cancelledWith = (observation: unknown): JsonValue =>
  projectAnalysisError(
    new AnalysisCancelledError("fixture_observation", {
      partialObservation: observation as Evidence,
    }),
    "invocation",
  );

const delivery = (root: string, sources?: readonly Evidence[]) => ({
  providerId: "fixture",
  operation: "fixture_observation",
  signal: new AbortController().signal,
  detail: "complete" as const,
  evidenceOutput: join(root, "evidence.json"),
  ...(sources === undefined ? {} : { sourceEvidence: sources }),
});

const closureOf = (output: unknown) =>
  (output as { details: { source_closure: UndeliveredSourceClosure } }).details
    .source_closure;

it("reports never-captured links as explicit omissions without fabricating records", async () => {
  const root = await createTestTempDirectory("rea-closure-missing-");
  const held = source("held", ["ev_".padEnd(67, "a")]);
  const neverCaptured = "ev_".padEnd(67, "b");
  const observation = observed([held.evidence_id, neverCaptured]);
  const closure = closureOf(
    await publishCliAnalysisEvidence(
      err(cancelledWith(observation)),
      delivery(root, [held]),
    ),
  );
  expect(closure.records.map((record) => record.evidence_id)).toEqual([
    held.evidence_id,
  ]);
  expect(parseEvidence(closure.records[0])).toEqual(held);
  // The ancestor of a held record is unresolved here, not absent.
  expect(closure.omitted).toEqual([
    { evidence_id: neverCaptured, reason: "not_captured" },
    { evidence_id: "ev_".padEnd(67, "a"), reason: "not_captured" },
  ]);
  expect(closure).toMatchObject({
    publication: "not_published",
    complete: false,
    omitted_count: 2,
  });
  expect(await readdir(root)).toEqual([]);
});

it("reports an unlinked captured source and stops at nothing linked or captured", async () => {
  const root = await createTestTempDirectory("rea-closure-unlinked-");
  const selected = source("selected");
  const observation = observed([]);
  expect(
    closureOf(
      await publishCliAnalysisEvidence(
        err(cancelledWith(observation)),
        delivery(root, [selected]),
      ),
    ).records,
  ).toEqual([selected]);

  const failure = cancelledWith(observation);
  expect(
    await publishCliAnalysisEvidence(err(failure), delivery(root, [])),
  ).toBe(failure);
  // A self-reference is the observation, not one of its sources.
  expect(
    await publishCliAnalysisEvidence(
      err(failure),
      delivery(root, [observation]),
    ),
  ).toBe(failure);
});

it("leaves failures untouched unless a completed observation requested delivery", async () => {
  const root = await createTestTempDirectory("rea-closure-untouched-");
  const held = source("held");
  const observation = observed([held.evidence_id]);
  const requested = delivery(root, [held]);

  // Without a selected output no source closure was requested on success either.
  const noOutput = cancelledWith(observation);
  expect(
    await publishCliAnalysisEvidence(err(noOutput), {
      ...requested,
      evidenceOutput: undefined,
    }),
  ).toBe(noOutput);

  const noObservation = projectAnalysisError(
    new AnalysisCancelledError("fixture_observation"),
    "invocation",
  );
  expect(await publishCliAnalysisEvidence(err(noObservation), requested)).toBe(
    noObservation,
  );

  const notEvidence = cancelledWith({ kind: "file-snapshot-read" });
  expect(await publishCliAnalysisEvidence(err(notEvidence), requested)).toBe(
    notEvidence,
  );

  // A failed authentication cannot select which sources an observation cites.
  const altered = cancelledWith({
    ...observation,
    evidence_links: [],
    normalized_result: { completed: false },
  });
  expect(await publishCliAnalysisEvidence(err(altered), requested)).toBe(
    altered,
  );
});

it("bounds records and listed omissions while counting everything", async () => {
  const root = await createTestTempDirectory("rea-closure-bounds-");
  const held = Array.from({ length: 200 }, (_, index) =>
    createEvidence(undefined, provider, {
      operation: "fixture_source",
      parameters: { index },
      result: { text: "x".repeat(4 * 1024) },
    }),
  );
  const missing = Array.from({ length: 100 }, (_, index) =>
    `ev_${index.toString(16).padStart(4, "0")}`.padEnd(67, "c"),
  );
  const observation = observed([
    ...held.map((record) => record.evidence_id),
    ...missing,
  ]);
  const closure = closureOf(
    await publishCliAnalysisEvidence(
      err(cancelledWith(observation)),
      delivery(root, held),
    ),
  );
  expect(closure.complete).toBe(false);
  expect(closure.records.length).toBeGreaterThan(0);
  expect(closure.records.length).toBeLessThan(held.length);
  const expectedOmissions = held.length + missing.length;
  expect(closure.omitted_count).toBe(
    expectedOmissions - closure.records.length,
  );
  expect(closure.omitted).toHaveLength(64);
  expect(jsonByteLength(closure)).toBeLessThan(80 * 1024);
});

/** Above V8's default call-argument limit of about 125,000 on a forked main thread. */
const DATA_SIZED_LINKS = 200_000;

const digestLink = (index: number) =>
  `ev_${index.toString(16).padStart(64, "0")}`;

const wideSource = (links: readonly string[]) =>
  createEvidence(undefined, provider, {
    operation: "fixture_source",
    parameters: {},
    result: { wide: true },
    evidenceLinks: links,
  });

it.each(["final-close cancellation", "refused publication"] as const)(
  "keeps the original failure when a captured source has a data-sized link set: %s",
  async (failure) => {
    const root = await createTestTempDirectory("rea-closure-wide-");
    const links = Array.from({ length: DATA_SIZED_LINKS }, (_, index) =>
      digestLink(index),
    );
    const wide = wideSource(links);
    const observation = observed([wide.evidence_id]);
    const requested = delivery(root, [wide]);
    if (failure === "refused publication")
      await writeFile(requested.evidenceOutput, "original");
    const output = await publishCliAnalysisEvidence(
      failure === "refused publication"
        ? ok(observation)
        : err(cancelledWith(observation)),
      requested,
    );
    expect(output).toMatchObject(
      failure === "refused publication"
        ? { details: { reason: "exists" } }
        : { code: "cancelled" },
    );
    const closure = closureOf(output);
    expect(closure.records).toEqual([]);
    expect(closure.omitted_count).toBe(DATA_SIZED_LINKS + 1);
    expect(closure.omitted).toHaveLength(64);
    expect(closure.omitted[0]).toEqual({
      evidence_id: wide.evidence_id,
      reason: "not_inlined",
    });
    expect(jsonByteLength(closure)).toBeLessThan(16 * 1024);
  },
  60_000,
);

it("reports a data-sized link set cited by the observation itself", async () => {
  const root = await createTestTempDirectory("rea-closure-wide-observation-");
  const closure = closureOf(
    await publishCliAnalysisEvidence(
      err(
        cancelledWith(
          observed(
            Array.from({ length: DATA_SIZED_LINKS }, (_, index) =>
              digestLink(index),
            ),
          ),
        ),
      ),
      delivery(root),
    ),
  );
  expect(closure.omitted_count).toBe(DATA_SIZED_LINKS);
  expect(closure.omitted).toHaveLength(64);
}, 60_000);

it("examines repeated links once across every captured source", async () => {
  const root = await createTestTempDirectory("rea-closure-dedupe-");
  const shared = source("shared");
  const repeated = Array.from(
    { length: DATA_SIZED_LINKS },
    () => shared.evidence_id,
  );
  const first = wideSource(repeated);
  const second = createEvidence(undefined, provider, {
    operation: "fixture_source",
    parameters: { second: true },
    result: { wide: true },
    evidenceLinks: repeated,
  });
  const closure = closureOf(
    await publishCliAnalysisEvidence(
      err(cancelledWith(observed([first.evidence_id, second.evidence_id]))),
      delivery(root, [first, second, shared]),
    ),
  );
  expect(closure.records).toEqual([shared]);
  expect(closure.omitted_count).toBe(2);
}, 60_000);

it.each([
  ["a captured source", "captured"],
  ["the completed observation", "observation"],
] as const)(
  "keeps the original failure when examining %s throws",
  async (_, thrower) => {
    const root = await createTestTempDirectory("rea-closure-throws-");
    const held = source("held");
    const failing = (record: Evidence) =>
      Object.defineProperty({ ...record }, "evidence_links", {
        enumerable: true,
        get: () => {
          throw new RangeError("quoted analyzed-value text");
        },
      }) as Evidence;
    const observation = observed([held.evidence_id]);
    const projected = cancelledWith(observation) as {
      details: Record<string, JsonValue>;
    };
    const partial =
      thrower === "observation"
        ? (failing(observation) as unknown as JsonValue)
        : projected.details.partial_observation!;
    const failure = {
      ...projected,
      details: { ...projected.details, partial_observation: partial },
    } as JsonValue;
    const output = (await publishCliAnalysisEvidence(
      err(failure),
      delivery(root, thrower === "captured" ? [failing(held)] : [held]),
    )) as {
      code: string;
      message: string;
      details: Record<string, unknown>;
    };
    expect(output.code).toBe("cancelled");
    expect(output.message).toBe((failure as { message: string }).message);
    expect(output.details.partial_observation).toBe(partial);
    expect(output.details.operation).toBe("fixture_observation");
    expect(output.details.source_closure).toEqual({
      publication: "not_published",
      complete: false,
      collection_failure: "RangeError",
      recovery: expect.any(String),
    });
    expect(JSON.stringify(output.details.source_closure)).not.toContain(
      "quoted analyzed-value text",
    );
    expect(await readdir(root)).toEqual([]);
  },
);

it("spends the allowance on smaller later records after a record does not fit", async () => {
  const root = await createTestTempDirectory("rea-closure-greedy-");
  const large = createEvidence(undefined, provider, {
    operation: "fixture_source",
    parameters: {},
    result: { text: "x".repeat(128 * 1024) },
  });
  const small = source("small");
  const closure = closureOf(
    await publishCliAnalysisEvidence(
      err(
        cancelledWith(observed([large.evidence_id, small.evidence_id].sort())),
      ),
      delivery(root, [large, small]),
    ),
  );
  expect(closure.records.map((record) => record.evidence_id)).toEqual([
    small.evidence_id,
  ]);
  expect(closure.omitted).toEqual([
    { evidence_id: large.evidence_id, reason: "not_inlined" },
  ]);
});

it("keeps captured records out of error output under explicit exclusions", async () => {
  const root = await createTestTempDirectory("rea-closure-sensitive-");
  const held = source("literal-secret-value");
  const output = await publishCliAnalysisEvidence(
    err(cancelledWith(observed([held.evidence_id]))),
    { ...delivery(root, [held]), sensitiveValues: ["literal-secret-value"] },
  );
  const closure = closureOf(output);
  expect(closure.records).toEqual([]);
  expect(closure.omitted).toEqual([
    { evidence_id: held.evidence_id, reason: "not_inlined" },
  ]);
  expect(JSON.stringify(closure)).not.toContain("literal-secret-value");
});

it("does not duplicate sources an artifact inspection already embeds", async () => {
  const root = await createTestTempDirectory("rea-closure-embedded-");
  const input = join(root, "input.txt");
  await writeFile(input, "artifact contents");
  const embedded = createEvidence(undefined, provider, {
    operation: "inventory_artifact",
    parameters: {},
    result: await inventoryArtifact(input),
  });
  const observation = createEvidence(undefined, provider, {
    operation: "inspect_artifact",
    parameters: {},
    result: createArtifactInspection(embedded),
    evidenceLinks: [embedded.evidence_id],
  });
  const output = await publishCliAnalysisEvidence(
    err(cancelledWith(observation)),
    { ...delivery(root), evidenceOutput: join(root, "bundle.json") },
  );
  expect(closureOf(output)).toMatchObject({
    publication: "not_published",
    complete: true,
    records: [],
    omitted_count: 0,
  });
});

it("reports the closure when cancellation precedes bundle commit", async () => {
  const root = await createTestTempDirectory("rea-closure-precommit-");
  const held = source("held");
  const observation = observed([held.evidence_id]);
  const controller = new AbortController();
  controller.abort(new Error("cancelled before publication"));
  const output = await publishCliAnalysisEvidence(ok(observation), {
    ...delivery(root, [held]),
    signal: controller.signal,
  });
  expect(output).toMatchObject({ code: "cancelled" });
  expect(closureOf(output).records).toEqual([held]);
  expect(await readdir(root)).toEqual([]);
});

it("reports the closure when an existing output refuses publication", async () => {
  const root = await createTestTempDirectory("rea-closure-exists-");
  const held = source("held");
  const requested = delivery(root, [held]);
  await writeFile(requested.evidenceOutput, "original");
  const output = await publishCliAnalysisEvidence(
    ok(observed([held.evidence_id])),
    requested,
  );
  expect(output).toMatchObject({ details: { reason: "exists" } });
  expect(closureOf(output).records).toEqual([held]);
  expect(await readFile(requested.evidenceOutput, "utf8")).toBe("original");
});

it("reports result sources when an existing output refuses publication", async () => {
  const root = await createTestTempDirectory("rea-closure-result-sources-");
  const held = source("held");
  const requested = delivery(root);
  await writeFile(requested.evidenceOutput, "original");
  const output = await publishCliAnalysisEvidence(
    { ...ok(observed([held.evidence_id])), sourceEvidence: [held] },
    requested,
  );
  expect(output).toMatchObject({ details: { reason: "exists" } });
  expect(closureOf(output)).toMatchObject({
    publication: "not_published",
    complete: true,
    omitted_count: 0,
    omitted: [],
  });
  expect(closureOf(output).records).toEqual([held]);
  expect(await readFile(requested.evidenceOutput, "utf8")).toBe("original");
});

it("defers to the committed bundle receipt after cancellation wins late", async () => {
  const root = await createTestTempDirectory("rea-closure-committed-");
  const held = source("held");
  const controller = new AbortController();
  const close = OwnedStagedOutput.prototype.close;
  const seam = vi
    .spyOn(OwnedStagedOutput.prototype, "close")
    .mockImplementationOnce(async function (this: OwnedStagedOutput) {
      await close.call(this);
      controller.abort(new Error("cancelled after commit"));
    });
  const requested = {
    ...delivery(root, [held]),
    signal: controller.signal,
  };
  let output: JsonValue;
  try {
    output = await publishCliAnalysisEvidence(
      ok(observed([held.evidence_id])),
      requested,
    );
  } finally {
    seam.mockRestore();
  }
  expect(output).toMatchObject({
    code: "cancelled",
    details: {
      diagnostics: { evidence_bundle: { path: requested.evidenceOutput } },
    },
  });
  expect(output).not.toHaveProperty("details.source_closure");
});

it("defers to the published file when staging cleanup stays incomplete after commit", async () => {
  const root = await createTestTempDirectory("rea-closure-published-");
  const held = source("held");
  const requested = delivery(root, [held]);
  const close = OwnedStagedOutput.prototype.close;
  const owners = new Set<OwnedStagedOutput>();
  const seam = vi
    .spyOn(OwnedStagedOutput.prototype, "close")
    .mockImplementation(async function (this: OwnedStagedOutput) {
      owners.add(this);
      throw new Error("controlled staging cleanup failure");
    });
  let output: JsonValue;
  try {
    output = await publishCliAnalysisEvidence(
      ok(observed([held.evidence_id])),
      requested,
    );
  } finally {
    seam.mockRestore();
    for (const owner of owners) await close.call(owner);
  }
  expect(output).toMatchObject({
    code: "cleanup_incomplete",
    details: { published_path: requested.evidenceOutput },
  });
  expect(output).not.toHaveProperty("details.source_closure");
});

it("does not change ordinary successful delivery", async () => {
  const root = await createTestTempDirectory("rea-closure-success-");
  const held = source("held");
  const observation = observed([held.evidence_id]);
  const requested = delivery(root, [held]);
  const delivered = await publishCliAnalysisEvidence(
    ok(observation),
    requested,
  );
  expect(JSON.stringify(delivered)).toBe(JSON.stringify(observation));
  const withoutOutput = await publishCliAnalysisEvidence(ok(observation), {
    ...requested,
    evidenceOutput: undefined,
  });
  expect(JSON.stringify(withoutOutput)).toBe(JSON.stringify(observation));
});

it.each(["interrupt", "cleanup-failure", "interrupt-cleanup-failure"] as const)(
  "states the sources a production direct analysis never captured: %s",
  async (scenario) => {
    const workflow = await composedWorkflowFixture();
    const controller = new AbortController();
    const close = workflow.session.close.bind(workflow.session);
    workflow.session.close = async () => {
      // The fixture's own final close retries this owner after the command.
      workflow.session.close = close;
      if (scenario !== "cleanup-failure") controller.abort();
      const closed = await close();
      if (scenario === "interrupt" || !closed.ok) return closed;
      return err(
        new ProviderCleanupError(
          "fixture",
          ["owned-root"],
          { reason: "controlled session close failure" },
          { operation: "close_binary" },
        ),
      );
    };
    const root = await createTestTempDirectory("rea-closure-direct-");
    const complete = await runDirectAnalysis(
      workflow.dependencies,
      workflow.path,
      "binary_overview",
      {},
      { signal: controller.signal },
    );
    const output = await publishCliAnalysisEvidence(complete, {
      ...delivery(root),
      signal: controller.signal,
    });
    const failure = output as {
      code: string;
      details: { partial_observation: unknown };
    };
    expect(failure.code).toBe(
      scenario === "interrupt" ? "cancelled" : "cleanup_incomplete",
    );
    const links = parseEvidence(
      failure.details.partial_observation,
    ).evidence_links;
    expect(links.length).toBeGreaterThan(0);
    expect(closureOf(output)).toMatchObject({
      publication: "not_published",
      complete: false,
      records: [],
      omitted_count: links.length,
      omitted: links.map((evidence_id) => ({
        evidence_id,
        reason: "not_captured",
      })),
    });
    expect(await readdir(root)).toEqual([]);
  },
);

it("reports through the shared one-shot delivery when cancellation arrives during close", async () => {
  const root = await createTestTempDirectory("rea-closure-deliver-");
  const held = source("held");
  const uncaptured = "ev_".padEnd(67, "d");
  const observation = observed([held.evidence_id, uncaptured]);
  const controller = new AbortController();
  const output = await deliverCliAnalysisEvidence({
    ...delivery(root, [held]),
    signal: controller.signal,
    run: async () => ok(observation),
    service: {
      close: async () => {
        controller.abort(new Error("cancelled during final close"));
      },
    },
  });
  expect(output).toMatchObject({
    code: "cancelled",
    details: { partial_observation: { evidence_id: observation.evidence_id } },
  });
  expect(closureOf(output)).toMatchObject({
    complete: false,
    records: [held],
    omitted: [{ evidence_id: uncaptured, reason: "not_captured" }],
  });
  expect(await readdir(root)).toEqual([]);
});

it("reports the closure when delivered view projection refuses a completed observation", async () => {
  const root = await createTestTempDirectory("rea-closure-view-");
  const held = source("held");
  const observation = observed([held.evidence_id]);
  const output = await publishCliAnalysisEvidence(ok(observation), {
    ...delivery(root, [held]),
    detail: "summary",
    // A view applying to another provider's facts cannot be selected here.
    view: { kind: "native", facet: "pseudocode", offset: 0, limit: 1 },
  });
  expect(closureOf(output).records).toEqual([held]);
  expect(await readdir(root)).toEqual([]);
});

it("leaves a primary failure without a completed observation untouched", async () => {
  const root = await createTestTempDirectory("rea-closure-primary-");
  const held = source("held");
  const primary = projectAnalysisError(
    new AnalysisOutputError("fixture_observation", "primary reply failure"),
    "invocation",
  );
  expect(
    await publishCliAnalysisEvidence(err(primary), delivery(root, [held])),
  ).toBe(primary);
});
