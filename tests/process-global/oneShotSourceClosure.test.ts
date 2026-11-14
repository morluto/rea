import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Cli } from "incur";
import { afterEach, expect, it, vi } from "vitest";

import type { UndeliveredSourceClosure } from "../../src/application/AnalysisEvidenceSources.js";
import * as matchingService from "../../src/application/native/NativeFunctionMatchingService.js";
import { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";
import { registerNativeFunctionMatchingCommands } from "../../src/cli/nativeFunctionMatchingCommands.js";
import { analysisErrorProjectionSchema } from "../../src/contracts/errorSchemas.js";
import { createEvidence, parseEvidence } from "../../src/domain/evidence.js";
import {
  createEvidenceBundle,
  parseEvidenceBundle,
} from "../../src/domain/evidenceBundle.js";
import { jsonByteLength } from "../../src/domain/jsonSerialization.js";
import { ProviderCleanupError } from "../../src/domain/providerCleanupError.js";
import { silentLogger } from "../../src/logger.js";
import {
  nativeMatchingInventory,
  nativeMatchingProvider,
} from "../fixtures/nativeFunctionMatching.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const host = vi.hoisted(() => ({
  listeners: new Map<string, () => void>(),
  get exitCode() {
    return process.exitCode;
  },
  set exitCode(value: typeof process.exitCode) {
    process.exitCode = value;
  },
  on(signal: string, listener: () => void) {
    this.listeners.set(signal, listener);
  },
  off(signal: string, listener: () => void) {
    if (this.listeners.get(signal) === listener) this.listeners.delete(signal);
  },
}));

vi.mock("../../src/cli/commandCancellation.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("../../src/cli/commandCancellation.js")
    >();
  return {
    ...original,
    withCommandCancellation: <Value>(
      operation: (signal: AbortSignal) => Promise<Value>,
    ) => original.withCommandCancellation(operation, host),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  host.listeners.clear();
});

type FinalClose =
  | "control"
  | "interrupt"
  | "cleanup-failure"
  | "interrupt-cleanup-failure";

const fixture = async (dependencyText = "Synthetic dependency") => {
  const root = await createTestTempDirectory("rea-source-closure-");
  const dependency = createEvidence(undefined, nativeMatchingProvider, {
    operation: "fixture_dependency",
    parameters: {},
    result: { source: dependencyText },
  });
  const left = nativeMatchingInventory(
    "1",
    [{ address: "0x10", value: "main" }],
    [dependency.evidence_id],
  );
  const right = nativeMatchingInventory("2", [
    { address: "0x20", value: "main" },
  ]);
  const sources = join(root, "sources.json");
  await writeFile(sources, JSON.stringify(createEvidenceBundle([dependency])));
  const request = join(root, "request.json");
  await writeFile(request, JSON.stringify({ left, right, detail: "complete" }));
  return {
    root,
    dependency,
    left,
    right,
    request,
    sources,
    output: join(root, "evidence.json"),
  };
};

/**
 * Run the registered command, faulting only the close of the scope the command
 * gave to matching, after that matching completed. Another scope's close cannot
 * move the fault, and a command that stops reaching this close fails here.
 */
const runMatching = async (
  input: Awaited<ReturnType<typeof fixture>>,
  finalClose: FinalClose,
  options: {
    readonly environment?: Readonly<Record<string, string>>;
    readonly earlierScopeClose?: boolean;
  } = {},
) => {
  const match = matchingService.matchNativeFunctionsFromBundles;
  const close = ArtifactResourceScope.prototype.close;
  let commandScope: ArtifactResourceScope | undefined;
  let completed = false;
  let finalCloses = 0;
  const matching = vi
    .spyOn(matchingService, "matchNativeFunctionsFromBundles")
    .mockImplementation(async (request, paths, resources, matchOptions) => {
      commandScope = resources;
      if (options.earlierScopeClose === true)
        await new ArtifactResourceScope().close();
      const result = await match(request, paths, resources, matchOptions);
      completed = result.ok;
      return result;
    });
  const seam = vi
    .spyOn(ArtifactResourceScope.prototype, "close")
    .mockImplementation(async function (this: ArtifactResourceScope) {
      if (this !== commandScope || !completed) return close.call(this);
      finalCloses += 1;
      if (
        finalClose === "interrupt" ||
        finalClose === "interrupt-cleanup-failure"
      )
        host.listeners.get("SIGINT")?.();
      await close.call(this);
      if (
        finalClose === "cleanup-failure" ||
        finalClose === "interrupt-cleanup-failure"
      )
        throw new ProviderCleanupError(
          "fixture",
          ["owned-root"],
          { reason: "controlled final close failure" },
          { operation: "match_native_functions" },
        );
    });
  const cli = Cli.create("one-shot-source-closure-test", { sync: false });
  registerNativeFunctionMatchingCommands(
    cli,
    silentLogger,
    options.environment ?? {},
  );
  let stdout = "";
  const previous = process.exitCode;
  try {
    process.exitCode = undefined;
    await cli.serve(
      [
        "match-native-functions",
        input.request,
        "--source_bundle",
        input.sources,
        "--evidence_output",
        input.output,
        "--json",
      ],
      {
        stdout: (part) => {
          stdout += part;
        },
        exit: () => {},
      },
    );
    expect(finalCloses, stdout).toBe(1);
    return { stdout, exitCode: process.exitCode };
  } finally {
    process.exitCode = previous;
    seam.mockRestore();
    matching.mockRestore();
  }
};

/** Above V8's default call-argument limit of about 125,000 on a forked main thread. */
const DATA_SIZED_LINKS = 200_000;

const closureOf = (stdout: string) => {
  const failure = analysisErrorProjectionSchema.parse(JSON.parse(stdout));
  const closure = failure.details?.source_closure as unknown as
    | UndeliveredSourceClosure
    | undefined;
  if (closure === undefined) throw new Error(`No source closure: ${stdout}`);
  return { failure, closure };
};

const recordIds = (closure: UndeliveredSourceClosure) =>
  closure.records.map((record) => parseEvidence(record).evidence_id).sort();

it.each([
  ["interrupt", "cancelled", 130],
  ["cleanup-failure", "cleanup_incomplete", 1],
  ["interrupt-cleanup-failure", "cleanup_incomplete", 130],
] as const)(
  "preserves captured linked sources through final close: %s",
  async (finalClose, code, exitCode) => {
    const input = await fixture();
    const { stdout, exitCode: observedExit } = await runMatching(
      input,
      finalClose,
    );
    expect(observedExit).toBe(exitCode);
    const failure = analysisErrorProjectionSchema.parse(JSON.parse(stdout));
    expect(failure.code).toBe(code);
    if (finalClose === "cleanup-failure") {
      expect(failure.details).toMatchObject({
        resources: ["owned-root"],
        diagnostics: { evidence_bundle: { path: input.output } },
      });
      expect(failure.details).not.toHaveProperty("source_closure");
      const saved = parseEvidenceBundle(
        JSON.parse(await readFile(input.output, "utf8")),
      );
      const observation = parseEvidence(failure.details?.partial_observation);
      expect(saved.records.map((record) => record.evidence_id).sort()).toEqual(
        [
          observation.evidence_id,
          input.left.evidence_id,
          input.right.evidence_id,
          input.dependency.evidence_id,
        ].sort(),
      );
      expect(host.listeners.size).toBe(0);
      return;
    }
    const { closure } = closureOf(stdout);
    const observation = parseEvidence(failure.details?.partial_observation);
    expect(observation.evidence_links).toEqual(
      [input.left.evidence_id, input.right.evidence_id].sort(),
    );
    // Sources are authentic originals, including the transitively linked one.
    expect(recordIds(closure)).toEqual(
      [
        input.dependency.evidence_id,
        input.left.evidence_id,
        input.right.evidence_id,
      ].sort(),
    );
    expect(closure).toMatchObject({
      publication: "not_published",
      complete: true,
      omitted_count: 0,
      omitted: [],
    });
    // Late cancellation never turns into successful or silent publication.
    expect(await readdir(input.root)).not.toContain("evidence.json");
    expect(host.listeners.size).toBe(0);
  },
);

it("keeps the fault on the final close when another scope closes first", async () => {
  const input = await fixture();
  const { stdout, exitCode } = await runMatching(input, "interrupt", {
    earlierScopeClose: true,
  });
  expect(exitCode).toBe(130);
  const { failure, closure } = closureOf(stdout);
  expect(failure.code).toBe("cancelled");
  expect(parseEvidence(failure.details?.partial_observation).operation).toBe(
    "match_native_functions",
  );
  expect(closure.complete).toBe(true);
});

it("keeps cancellation typed for a captured source with a data-sized link set", async () => {
  // Repeated links are valid Evidence, and only one distinct record backs them.
  const ancestor = createEvidence(undefined, nativeMatchingProvider, {
    operation: "fixture_ancestor",
    parameters: {},
    result: { source: "Synthetic ancestor" },
  });
  const wide = createEvidence(undefined, nativeMatchingProvider, {
    operation: "fixture_dependency",
    parameters: {},
    result: { source: "Synthetic wide dependency" },
    evidenceLinks: Array.from(
      { length: DATA_SIZED_LINKS },
      () => ancestor.evidence_id,
    ),
  });
  const input = await fixture();
  const left = nativeMatchingInventory(
    "1",
    [{ address: "0x10", value: "main" }],
    [wide.evidence_id],
  );
  await writeFile(
    input.sources,
    JSON.stringify(createEvidenceBundle([ancestor, wide])),
  );
  await writeFile(
    input.request,
    JSON.stringify({ left, right: input.right, detail: "complete" }),
  );
  const { stdout } = await runMatching(input, "interrupt", {
    environment: {
      REA_NATIVE_MATCHING_REPRESENTATION_BYTES: String(1024 ** 3),
    },
  });
  const { failure, closure } = closureOf(stdout);
  expect(failure.code).toBe("cancelled");
  expect(parseEvidence(failure.details?.partial_observation).operation).toBe(
    "match_native_functions",
  );
  // The closure is deduplicated: each record is examined and reported once.
  expect(recordIds(closure)).toEqual(
    [ancestor.evidence_id, left.evidence_id, input.right.evidence_id].sort(),
  );
  expect(closure).toMatchObject({
    complete: false,
    omitted_count: 1,
    omitted: [{ evidence_id: wide.evidence_id, reason: "not_inlined" }],
  });
});

it("hands off the same closure for summary delivery and permits a clean retry", async () => {
  const input = await fixture();
  await writeFile(
    input.request,
    JSON.stringify({
      left: input.left,
      right: input.right,
      detail: "summary",
    }),
  );
  const cancelled = await runMatching(input, "interrupt");
  const { closure } = closureOf(cancelled.stdout);
  expect(closure.complete).toBe(true);

  const retried = await runMatching(input, "control");
  expect(retried.exitCode).toBeUndefined();
  expect(JSON.parse(retried.stdout)).not.toHaveProperty(
    "details.source_closure",
  );
  const saved = parseEvidenceBundle(
    JSON.parse(await readFile(input.output, "utf8")),
  );
  const savedIds = saved.records.map((record) => record.evidence_id);
  expect(savedIds).toEqual(expect.arrayContaining(recordIds(closure)));
});

it("keeps an oversized source explicit instead of expanding the failure", async () => {
  const input = await fixture("x".repeat(128 * 1024));
  const { stdout } = await runMatching(input, "interrupt");
  const { failure, closure } = closureOf(stdout);
  expect(failure.code).toBe("cancelled");
  expect(recordIds(closure)).toEqual(
    [input.left.evidence_id, input.right.evidence_id].sort(),
  );
  expect(closure).toMatchObject({
    complete: false,
    omitted_count: 1,
    omitted: [
      { evidence_id: input.dependency.evidence_id, reason: "not_inlined" },
    ],
  });
  expect(jsonByteLength(closure)).toBeLessThan(64 * 1024);

  // The omitted record stays reachable through ordinary delivery.
  const retried = await runMatching(input, "control");
  expect(retried.exitCode).toBeUndefined();
  const saved = parseEvidenceBundle(
    JSON.parse(await readFile(input.output, "utf8")),
  );
  expect(saved.records.map((record) => record.evidence_id)).toContain(
    input.dependency.evidence_id,
  );
});

it("leaves ordinary successful delivery free of closure reporting", async () => {
  const input = await fixture();
  const { stdout, exitCode } = await runMatching(input, "control");
  expect(exitCode).toBeUndefined();
  expect(stdout).not.toContain("source_closure");
  const delivered = parseEvidence(JSON.parse(stdout));
  const saved = parseEvidenceBundle(
    JSON.parse(await readFile(input.output, "utf8")),
  );
  expect(saved.records.map((record) => record.evidence_id).sort()).toEqual(
    [
      delivered.evidence_id,
      input.dependency.evidence_id,
      input.left.evidence_id,
      input.right.evidence_id,
    ].sort(),
  );
});
