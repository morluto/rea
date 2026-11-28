import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { expect, it } from "vitest";

import { inspectAnalysisView } from "../../../src/application/analysisView/AnalysisViewService.js";
import { createCli } from "../../../src/cli.js";
import { publishCliAnalysisEvidence } from "../../../src/cli/analysisEvidenceDelivery.js";
import {
  cliEvidencePublicationReceipt,
  retainCliPublicationOnError,
  withCliEvidencePublication,
} from "../../../src/cli/cliEvidencePublication.js";
import {
  cliRetainedEvidenceDirectory,
  retainCliEvidence,
  retainedEvidenceDigest,
} from "../../../src/cli/cliEvidenceRetention.js";
import { createByteEntropyService } from "../../../src/composition/binaryDiagnostics/byteEntropy.js";
import { PARTIAL_OBSERVATION_DELIVERY } from "../../../src/domain/agentResultBudget.js";
import { CLI_RETAINED_EVIDENCE_MAX_AGE_MS } from "../../../src/domain/analysisResourceLimits.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import {
  createEvidence,
  parseEvidence,
  withEvidenceCallerInputPath,
  type Evidence,
} from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { err, ok } from "../../../src/domain/result.js";
import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import { HOST_PLATFORM } from "../../../src/platform/HostPlatform.js";
import { writeOrderedZip } from "../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

type Output = {
  readonly summary: unknown;
  readonly evidence_bundle?: {
    readonly path: string;
    readonly bytes: number;
    readonly record_sha256: string;
  };
  readonly delivery: {
    readonly retained: string;
    readonly evidence_id: string;
    readonly complete_bytes: number;
    readonly retention_failure?: string;
    readonly rerun?: unknown;
    readonly next?: {
      readonly arguments: {
        readonly source: Record<string, string>;
        readonly view: Record<string, unknown>;
      };
    };
  };
};

/** A fresh home and cache, and a 1 MiB target whose entropy is over budget. */
const workspace = async (extra: Record<string, string> = {}) => {
  const home = await createTestTempDirectory("rea-retain-home-");
  const cache = await createTestTempDirectory("rea-retain-cache-");
  const root = await createTestTempDirectory("rea-retain-target-");
  const target = join(root, "bytes");
  await writeFile(target, randomBytes(1024 * 1024));
  // The shipped defaults: no test seed for the budget or the cache size.
  const environment: Record<string, string> = {
    HOME: home,
    XDG_CACHE_HOME: cache,
    TMPDIR: root,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...extra,
  };
  const directory = cliRetainedEvidenceDirectory(environment, process.platform);
  const serve = async (argv: readonly string[]): Promise<unknown> => {
    let stdout = "";
    let exitCode = 0;
    await createCli(environment).serve([...argv], {
      env: environment,
      exit: (code) => {
        exitCode = code;
      },
      stdout: (text) => {
        stdout += text;
      },
    });
    expect(exitCode, stdout).toBe(0);
    return JSON.parse(stdout) as unknown;
  };
  const runOn = (spelling: string, ...flags: string[]) =>
    serve([
      "inspect-byte-entropy",
      spelling,
      "--block-size",
      "256",
      "--json",
      ...flags,
    ]) as Promise<Output>;
  const run = (...flags: string[]) => runOn(target, ...flags);
  return { run, runOn, serve, directory, target };
};

const files = (directory: string) =>
  readdir(directory).catch((cause: unknown) => {
    if ((cause as { code?: string }).code === "ENOENT") return [];
    throw cause;
  });

it("keeps an over-budget CLI result in the private cache, pages it, and reuses it", async () => {
  const { run, runOn, serve, directory, target } = await workspace();
  const first = await run();
  expect(parseEvidence(first.summary).operation).toBe("inspect_analysis_view");
  const id = first.delivery.evidence_id;
  const sha256 = first.evidence_bundle!.record_sha256;
  // Paths name the cache directory as the filesystem resolves it.
  const path = first.evidence_bundle!.path;
  expect(dirname(path)).toBe(await realpath(directory));
  expect(basename(path)).toMatch(/^[0-9a-f]{64}\.json$/u);
  expect(first.delivery).toMatchObject({ retained: "cache-file" });
  expect(first.evidence_bundle).toEqual({
    path,
    bytes: (await stat(path)).size,
    record_sha256: sha256,
  });
  expect(first.delivery.next?.arguments.source).toEqual({
    kind: "evidence-file",
    path,
    evidence_id: id,
  });
  if (process.platform !== "win32") {
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  }

  // The retained file pages through the existing file source.
  const page = await inspectAnalysisView({
    ...first.delivery.next!.arguments,
    view: { kind: "evidence-json", offset: 0, limit: 1_048_576 },
  });
  if (!page.ok) throw page.error;
  const { text } = page.value.normalized_result as unknown as {
    readonly text: string;
  };
  const complete = await run("--detail", "complete");
  expect(JSON.parse(text)).toEqual(complete);
  // The public receipt still identifies the parent's exact JSON.
  expect(sha256).toBe(
    createHash("sha256").update(JSON.stringify(complete)).digest("hex"),
  );
  expect(Buffer.byteLength(JSON.stringify(complete))).toBe(
    first.delivery.complete_bytes,
  );

  // A repeat run reuses the same file, never rewrites it, and renews its age.
  const old = new Date(Date.now() - 60_000);
  await utimes(path, old, old);
  const before = await stat(path);
  const repeat = await run();
  expect(repeat.evidence_bundle).toEqual(first.evidence_bundle);
  const after = await stat(path);
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);
  expect(await files(directory)).toEqual([basename(path)]);

  // Paging it through the CLI uses it too, and renews its age again.
  await utimes(path, old, old);
  const viewed = (await serve([
    "inspect-analysis-view",
    JSON.stringify(first.delivery.next!.arguments),
    "--json",
  ])) as { readonly evidence_id: string };
  expect(viewed.evidence_id).toEqual(expect.any(String));
  expect((await stat(path)).mtimeMs).toBeGreaterThan(old.getTime() + 1_000);

  // Another spelling of the same target records another caller path, so it
  // keeps its own record rather than recovering the first run's.
  const spelled = await runOn(relative(process.cwd(), target));
  expect(spelled.evidence_bundle!.record_sha256).not.toBe(sha256);
  expect((await files(directory)).sort()).toEqual(
    [basename(path), basename(spelled.evidence_bundle!.path)].sort(),
  );
});

it("retains nothing with --no-retain or a zero setting", async () => {
  const flagged = await workspace();
  const off = await flagged.run("--no-retain");
  expect(off.delivery).toMatchObject({ retained: "not-retained" });
  expect(off.delivery.rerun).toBeDefined();
  expect(off.delivery.retention_failure).toBeUndefined();
  expect(off.evidence_bundle).toBeUndefined();
  expect(await files(flagged.directory)).toEqual([]);

  const seeded = await workspace({ REA_CLI_RETAINED_EVIDENCE_BYTES: "0" });
  const zero = await seeded.run();
  expect(zero.delivery).toMatchObject({ retained: "not-retained" });
  expect(await files(seeded.directory)).toEqual([]);
});

it("falls back to the rerun arguments when the cache cannot be used", async () => {
  const blocked = await workspace();
  // Something that is not a directory where the cache directory belongs.
  await mkdir(dirname(blocked.directory), { recursive: true });
  await writeFile(blocked.directory, "not a directory");
  const output = await blocked.run();
  expect(parseEvidence(output.summary).operation).toBe("inspect_analysis_view");
  expect(output.delivery).toMatchObject({ retained: "not-retained" });
  expect(output.delivery.rerun).toBeDefined();
  expect(output.delivery.retention_failure).toEqual(expect.any(String));
  expect(output.evidence_bundle).toBeUndefined();

  // A record larger than the cache is not kept either.
  const small = await workspace({ REA_CLI_RETAINED_EVIDENCE_BYTES: "1024" });
  const capped = await small.run();
  expect(capped.delivery.retention_failure).toContain("larger than");
  expect(await files(small.directory)).toEqual([]);
});

it("removes records past their age, then the least recently used over the cap", async () => {
  const directory = join(
    await createTestTempDirectory("rea-retain-evict-"),
    "evidence",
  );
  await mkdir(directory, { mode: 0o700 });
  const now = Date.now();
  const record = async (digit: string, bytes: number, ageMs: number) => {
    const name = `${digit.repeat(64)}.json`;
    await writeFile(join(directory, name), "x".repeat(bytes));
    const used = new Date(now - ageMs);
    await utimes(join(directory, name), used, used);
    return name;
  };
  const expired = await record("a", 10, CLI_RETAINED_EVIDENCE_MAX_AGE_MS + 1);
  const oldest = await record("b", 400, 3_000);
  const newer = await record("c", 400, 2_000);
  // Not a retained record: never removed.
  await writeFile(join(directory, "notes.txt"), "keep");
  const retain = (digit: string, capBytes: number) =>
    retainCliEvidence({
      cacheKey: digit.repeat(64),
      completeBytes: 400,
      retention: { directory, capBytes },
      now,
      write: async (path) => {
        await writeFile(path, "y".repeat(400), { flag: "wx", mode: 0o600 });
        return ok({ bytes: 400 });
      },
    });
  const named = (digit: string) => `${digit.repeat(64)}.json`;

  // Within the cap, only the record past its age is removed.
  expect(await retain("d", 10_000)).toMatchObject({
    ok: true,
    value: { reused: false },
  });
  expect((await files(directory)).sort()).toEqual(
    [oldest, newer, named("d"), "notes.txt"].sort(),
  );
  // Over the cap, the least recently used go first, never the one just kept.
  expect(await retain("e", 1_000)).toMatchObject({ ok: true });
  expect((await files(directory)).sort()).toEqual(
    [named("d"), named("e"), "notes.txt"].sort(),
  );
  expect(expired).toBe(named("a"));

  // A bundle that outgrows the cache with the sources it cites is removed.
  const oversized = await retainCliEvidence({
    cacheKey: "f".repeat(64),
    completeBytes: 100,
    retention: { directory, capBytes: 500 },
    now,
    write: async (path) => {
      await writeFile(path, "z".repeat(600), { flag: "wx", mode: 0o600 });
      return ok({ bytes: 600 });
    },
  });
  expect(oversized).toMatchObject({ ok: false });
  if (!oversized.ok) expect(oversized.error.fileRemains).toBeUndefined();
  expect(await files(directory)).not.toContain(named("f"));

  // When removing an oversized bundle fails, retainCliEvidence reports
  // `fileRemains: true` so the caller keeps the published file's receipt.
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const stuckDir = join(
      await createTestTempDirectory("rea-retain-stuck-"),
      "evidence",
    );
    await mkdir(stuckDir, { mode: 0o700 });
    try {
      const stuck = await retainCliEvidence({
        cacheKey: "9".repeat(64),
        completeBytes: 100,
        retention: { directory: stuckDir, capBytes: 500 },
        now,
        write: async (path) => {
          await writeFile(path, "z".repeat(600), { flag: "wx", mode: 0o600 });
          await chmod(stuckDir, 0o500);
          return ok({ bytes: 600 });
        },
      });
      expect(stuck).toMatchObject({
        ok: false,
        error: { fileRemains: true },
      });
      expect(await files(stuckDir)).toContain(named("9"));
    } finally {
      await chmod(stuckDir, 0o700);
    }
  }
});

it("keys a retained record by its complete content, not its Evidence ID", async () => {
  const root = await createTestTempDirectory("rea-retain-digest-");
  const path = join(root, "bytes");
  await writeFile(path, randomBytes(4096));
  const inspected = await createByteEntropyService().inspect({
    path,
    block_size: 256,
  });
  if (!inspected.ok) throw inspected.error;
  // The caller's spelling is recorded but is not part of the Evidence ID.
  const spelled = withEvidenceCallerInputPath(inspected.value, "./bytes");
  expect(spelled.evidence_id).toBe(inspected.value.evidence_id);
  expect(retainedEvidenceDigest(spelled)).not.toBe(
    retainedEvidenceDigest(inspected.value),
  );
  expect(retainedEvidenceDigest(spelled)).toBe(
    createHash("sha256").update(JSON.stringify(spelled)).digest("hex"),
  );
});

it("never uses a cache whose path holds a value marked sensitive", async () => {
  const marked = "s3cr3t-token";
  const root = await createTestTempDirectory("rea-retain-sensitive-");
  const directory = join(root, marked, "evidence");
  const target = join(root, "bytes");
  await writeFile(target, randomBytes(1024 * 1024));
  const inspected = await createByteEntropyService().inspect({
    path: target,
    block_size: 256,
  });
  if (!inspected.ok) throw inspected.error;
  const output = (await withCliEvidencePublication(
    () =>
      publishCliAnalysisEvidence(inspected, {
        operation: "inspect_byte_entropy",
        signal: new AbortController().signal,
        detail: undefined,
        evidenceOutput: undefined,
        sensitiveValues: [marked],
      }),
    { retention: { directory, capBytes: 1024 * 1024 * 1024 } },
  )) as Output;
  expect(output.delivery).toMatchObject({ retained: "not-retained" });
  expect(output.delivery.retention_failure).toEqual(expect.any(String));
  expect(JSON.stringify(output)).not.toContain(marked);
  expect(await files(join(root, marked))).toEqual([]);

  // A symlinked cache root whose resolved target holds a marked value is also refused.
  const secretRoot = join(root, marked);
  const linkRoot = join(root, "cache-link");
  await mkdir(secretRoot, { recursive: true, mode: 0o700 });
  await symlink(secretRoot, linkRoot);
  const linked = (await withCliEvidencePublication(
    () =>
      publishCliAnalysisEvidence(inspected, {
        operation: "inspect_byte_entropy",
        signal: new AbortController().signal,
        detail: undefined,
        evidenceOutput: undefined,
        sensitiveValues: [marked],
      }),
    {
      retention: {
        directory: join(linkRoot, "evidence"),
        capBytes: 1024 * 1024 * 1024,
      },
    },
  )) as Output;
  expect(linked.delivery).toMatchObject({ retained: "not-retained" });
  expect(linked.delivery.retention_failure).toEqual(expect.any(String));
  expect(JSON.stringify(linked)).not.toContain(marked);
  expect(await files(join(secretRoot, "evidence"))).toEqual([]);
});

it("withdraws the publication receipt of a bundle the cache discards", async () => {
  const root = await createTestTempDirectory("rea-retain-receipt-");
  const directory = join(root, "evidence");
  const target = join(root, "bytes");
  await writeFile(target, randomBytes(1024 * 1024));
  const inspected = await createByteEntropyService().inspect({
    path: target,
    block_size: 256,
  });
  if (!inspected.ok) throw inspected.error;
  // The record fits the cache; its bundle, with the bundle's own fields, does not.
  const capBytes = Buffer.byteLength(JSON.stringify(inspected.value)) + 16;
  const { output, receipt } = await withCliEvidencePublication(
    async () => ({
      output: (await publishCliAnalysisEvidence(inspected, {
        operation: "inspect_byte_entropy",
        signal: new AbortController().signal,
        detail: undefined,
        evidenceOutput: undefined,
      })) as Output,
      receipt: cliEvidencePublicationReceipt(),
    }),
    { retention: { directory, capBytes } },
  );
  expect(output.delivery).toMatchObject({ retained: "not-retained" });
  expect(output.delivery.retention_failure).toContain("larger than");
  expect(receipt).toBeUndefined();
  expect(await files(directory)).toEqual([]);
});

// Windows resolves .. lexically; POSIX resolves it after the link.
it.skipIf(HOST_PLATFORM.platform === "win32")(
  "keeps the filesystem meaning of a cache path with .. after a symbolic link",
  async () => {
    const root = await realpath(
      await createTestTempDirectory("rea-retain-dotdot-"),
    );
    await mkdir(join(root, "real", "deep"), { recursive: true });
    await symlink(join(root, "real", "deep"), join(root, "link"));
    // The kernel resolves link/.. to real; lexical joining would give root.
    const directory = join(root, "link") + "/../evidence";
    const kept = await retainCliEvidence({
      cacheKey: "e".repeat(64),
      completeBytes: 10,
      retention: { directory, capBytes: 1_000 },
      write: async (path) => {
        await writeFile(path, "y".repeat(10), { flag: "wx", mode: 0o600 });
        return ok({ bytes: 10 });
      },
    });
    expect(kept).toMatchObject({
      ok: true,
      value: { path: join(root, "real", "evidence", `${"e".repeat(64)}.json`) },
    });
    expect(await files(join(root, "evidence"))).toEqual([]);
  },
);

type FailureOutput = {
  readonly code: string;
  readonly message: string;
  readonly failure_kind?: string;
  readonly retryable: boolean;
  readonly remediation: { readonly action: string };
  readonly details: {
    readonly partial_observation: unknown;
    readonly [PARTIAL_OBSERVATION_DELIVERY]?: Output["delivery"];
    readonly diagnostics?: {
      readonly existing?: string;
      readonly evidence_bundle?: Output["evidence_bundle"];
    };
    readonly limits?: unknown;
  };
};

const largeJavaScriptApplication = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-retain-js-failure-");
  await writeFile(
    join(root, "package.json"),
    '{"name":"retained-partial","main":"m0.js"}',
  );
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      writeFile(
        join(root, `m${String(index)}.js`),
        `export const value_${String(index)} = ${String(index)};\n`,
      ),
    ),
  );
  return root;
};

const serveCli = async (
  environment: Record<string, string>,
  argv: readonly string[],
): Promise<{ readonly json: unknown }> => {
  let stdout = "";
  await createCli(environment).serve([...argv], {
    env: environment,
    exit: () => {},
    stdout: (text) => {
      stdout += text;
    },
  });
  return { json: JSON.parse(stdout) as unknown };
};

it("retains an over-budget partial observation from a failed CLI run, pages it, and respects opt-out and fallback", async () => {
  const appRoot = await largeJavaScriptApplication();
  const setup = async (extra: Record<string, string> = {}) => {
    const home = await createTestTempDirectory("rea-retain-fail-home-");
    const cache = await createTestTempDirectory("rea-retain-fail-cache-");
    const tmp = await createTestTempDirectory("rea-retain-fail-tmp-");
    const environment: Record<string, string> = {
      HOME: home,
      XDG_CACHE_HOME: cache,
      TMPDIR: tmp,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      ...extra,
    };
    return {
      environment,
      directory: cliRetainedEvidenceDirectory(environment, process.platform),
      run: (...flags: string[]) =>
        serveCli(environment, [
          "analyze-javascript-application",
          appRoot,
          "--max-heap-mb",
          "128",
          "--analysis-timeout-ms",
          "1",
          "--json",
          ...flags,
        ]),
    };
  };

  const defaultRun = await setup();
  const first = await defaultRun.run();
  const failure = first.json as FailureOutput;
  expect(failure.code).toBe("provider_timeout");
  expect(parseEvidence(failure.details.partial_observation).operation).toBe(
    "inspect_analysis_view",
  );
  const delivery = failure.details[PARTIAL_OBSERVATION_DELIVERY]!;
  expect(delivery).toMatchObject({ retained: "cache-file" });
  const receipt = failure.details.diagnostics?.evidence_bundle;
  expect(receipt).toBeDefined();
  const expectedPath = receipt!.path;
  expect(dirname(expectedPath)).toBe(await realpath(defaultRun.directory));
  expect(basename(expectedPath)).toMatch(/^[0-9a-f]{64}\.json$/u);
  expect(receipt).toEqual({
    path: expectedPath,
    bytes: (await stat(expectedPath)).size,
    record_sha256: receipt!.record_sha256,
  });
  expect(delivery.next?.arguments.source).toEqual({
    kind: "evidence-file",
    path: expectedPath,
    evidence_id: delivery.evidence_id,
  });

  // Reading the retained file yields the exact complete partial observation.
  const page = await inspectAnalysisView({
    ...delivery.next!.arguments,
    view: { kind: "evidence-json", offset: 0, limit: 1_048_576 },
  });
  if (!page.ok) throw page.error;
  const { text } = page.value.normalized_result as unknown as {
    readonly text: string;
  };
  const rawComplete = JSON.parse(text) as unknown;
  const completePartial = parseEvidence(rawComplete);
  expect(completePartial.operation).toBe("analyze_javascript_application");
  expect(completePartial.evidence_id).toBe(delivery.evidence_id);
  expect(receipt!.record_sha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(Buffer.byteLength(text)).toBe(delivery.complete_bytes);
  const bundle = parseEvidenceBundle(
    JSON.parse(await readFile(expectedPath, "utf8")),
  );
  expect(
    bundle.records.find(
      ({ evidence_id: id }) => id === completePartial.evidence_id,
    ),
  ).toEqual(rawComplete);

  // --detail complete delivers the same failure facts with inline partial Evidence.
  const completeReply = await defaultRun.run("--detail", "complete");
  const completeFailure = completeReply.json as FailureOutput;
  expect(failure.code).toBe(completeFailure.code);
  expect(failure.retryable).toBe(completeFailure.retryable);
  expect(failure.remediation).toEqual(completeFailure.remediation);
  expect(completeFailure.details[PARTIAL_OBSERVATION_DELIVERY]).toBeUndefined();

  // --no-retain and REA_CLI_RETAINED_EVIDENCE_BYTES=0 opt out without writing.
  const optedOut = await setup();
  const noRetain = await optedOut.run("--no-retain");
  const noRetainFailure = noRetain.json as FailureOutput;
  expect(noRetainFailure.details[PARTIAL_OBSERVATION_DELIVERY]).toMatchObject({
    retained: "not-retained",
  });
  expect(
    noRetainFailure.details[PARTIAL_OBSERVATION_DELIVERY]?.rerun,
  ).toBeDefined();
  expect(
    noRetainFailure.details[PARTIAL_OBSERVATION_DELIVERY]?.retention_failure,
  ).toBeUndefined();
  expect(noRetainFailure.details.diagnostics?.evidence_bundle).toBeUndefined();
  expect(await files(optedOut.directory)).toEqual([]);

  const zeroCap = await setup({ REA_CLI_RETAINED_EVIDENCE_BYTES: "0" });
  const zeroReply = await zeroCap.run();
  const zeroFailure = zeroReply.json as FailureOutput;
  expect(zeroFailure.details[PARTIAL_OBSERVATION_DELIVERY]).toMatchObject({
    retained: "not-retained",
  });
  expect(zeroFailure.details.diagnostics?.evidence_bundle).toBeUndefined();
  expect(await files(zeroCap.directory)).toEqual([]);

  // Retention write failures fall back to rerun arguments without changing failure facts.
  const blocked = await setup();
  await mkdir(dirname(blocked.directory), { recursive: true });
  await writeFile(blocked.directory, "not a directory");
  const blockedReply = await blocked.run();
  const blockedFailure = blockedReply.json as FailureOutput;
  expect(blockedFailure.code).toBe("provider_timeout");
  expect(blockedFailure.remediation).toEqual(completeFailure.remediation);
  expect(blockedFailure.details[PARTIAL_OBSERVATION_DELIVERY]).toMatchObject({
    retained: "not-retained",
  });
  expect(
    blockedFailure.details[PARTIAL_OBSERVATION_DELIVERY]?.rerun,
  ).toBeDefined();
  expect(
    blockedFailure.details[PARTIAL_OBSERVATION_DELIVERY]?.retention_failure,
  ).toEqual(expect.any(String));
  expect(blockedFailure.details.diagnostics?.evidence_bundle).toBeUndefined();

  const smallCap = await setup({ REA_CLI_RETAINED_EVIDENCE_BYTES: "1024" });
  const cappedReply = await smallCap.run();
  const cappedFailure = cappedReply.json as FailureOutput;
  expect(
    cappedFailure.details[PARTIAL_OBSERVATION_DELIVERY]?.retention_failure,
  ).toContain("larger than");
  expect(cappedFailure.details.diagnostics?.evidence_bundle).toBeUndefined();
  expect(await files(smallCap.directory)).toEqual([]);
});

it("preserves failure facts, source closure, sensitive-path redaction, receipt withdrawal, and cancellation no-publication", async () => {
  const root = await createTestTempDirectory("rea-retain-fail-boundary-");
  const target = join(root, "bytes");
  await writeFile(target, randomBytes(1024 * 1024));
  const inspected = await createByteEntropyService().inspect({
    path: target,
    block_size: 256,
  });
  if (!inspected.ok) throw inspected.error;
  const sourceRecord = createEvidence(
    unknownTarget("not-observed"),
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "source_fixture",
      parameters: {},
      result: { marker: "source-closure-kept" },
    },
  );
  const failure = {
    code: "provider_timeout",
    message: "Analysis timed out after partial work.",
    failure_kind: "timeout",
    retryable: true,
    remediation: {
      action: "Increase the timeout or inspect partial_observation.",
    },
    details: {
      limits: { timeout_ms: 1000 },
      diagnostics: { existing: "kept" },
      partial_observation: inspected.value,
    },
  };

  // Retains complete partial observation plus result.sourceEvidence, keeps failure facts and existing diagnostics, and reuses on repeat.
  const directory = join(root, "cache");
  const publish = (
    input: {
      readonly error?: typeof failure;
      readonly signal?: AbortSignal;
      readonly sensitiveValues?: readonly string[];
      readonly retentionDir?: string;
      readonly capBytes?: number;
    } = {},
  ) =>
    withCliEvidencePublication(
      async () => ({
        output: (await publishCliAnalysisEvidence(
          {
            ...err(input.error ?? failure),
            sourceEvidence: [sourceRecord],
          },
          {
            operation: "inspect_byte_entropy",
            signal: input.signal ?? new AbortController().signal,
            detail: undefined,
            evidenceOutput: undefined,
            ...(input.sensitiveValues === undefined
              ? {}
              : { sensitiveValues: input.sensitiveValues }),
          },
        )) as FailureOutput,
        receipt: cliEvidencePublicationReceipt(),
      }),
      {
        retention: {
          directory: input.retentionDir ?? directory,
          capBytes: input.capBytes ?? 1024 * 1024 * 1024,
        },
      },
    );

  const first = await publish();
  expect(first.output.code).toBe(failure.code);
  expect(first.output.message).toBe(failure.message);
  expect(first.output.failure_kind).toBe(failure.failure_kind);
  expect(first.output.retryable).toBe(failure.retryable);
  expect(first.output.remediation).toEqual(failure.remediation);
  expect(first.output.details.limits).toEqual(failure.details.limits);
  expect(first.output.details.diagnostics?.existing).toBe("kept");
  const firstReceipt = first.output.details.diagnostics?.evidence_bundle!;
  expect(firstReceipt).toEqual(first.receipt);
  expect(firstReceipt.record_sha256).toBe(
    retainedEvidenceDigest(inspected.value),
  );
  const savedBundle = parseEvidenceBundle(
    JSON.parse(await readFile(firstReceipt.path, "utf8")),
  );
  expect(savedBundle.records.map((r) => r.evidence_id)).toEqual(
    expect.arrayContaining([
      inspected.value.evidence_id,
      sourceRecord.evidence_id,
    ]),
  );
  expect(
    savedBundle.records.find(
      ({ evidence_id: id }) => id === inspected.value.evidence_id,
    ),
  ).toEqual(inspected.value);

  const old = new Date(Date.now() - 60_000);
  await utimes(firstReceipt.path, old, old);
  const before = await stat(firstReceipt.path);
  const repeat = await publish();
  expect(repeat.output.details.diagnostics?.evidence_bundle).toEqual(
    firstReceipt,
  );
  const after = await stat(firstReceipt.path);
  expect(after.ino).toBe(before.ino);
  expect(after.mtimeMs).toBeGreaterThan(before.mtimeMs);

  // Cancelled failures keep the no-publication contract: never write, create, or renew cache files.
  const cancelledDir = join(root, "cancelled-cache");
  const cancelledByCode = await publish({
    error: { ...failure, code: "cancelled" },
    retentionDir: cancelledDir,
  });
  expect(
    cancelledByCode.output.details[PARTIAL_OBSERVATION_DELIVERY],
  ).toMatchObject({ retained: "not-retained" });
  expect(
    cancelledByCode.output.details[PARTIAL_OBSERVATION_DELIVERY]
      ?.retention_failure,
  ).toBeUndefined();
  expect(
    cancelledByCode.output.details.diagnostics?.evidence_bundle,
  ).toBeUndefined();
  expect(await files(cancelledDir)).toEqual([]);

  const aborted = new AbortController();
  aborted.abort();
  await utimes(firstReceipt.path, old, old);
  const beforeAborted = (await stat(firstReceipt.path)).mtimeMs;
  const abortedReply = await publish({ signal: aborted.signal });
  expect(
    abortedReply.output.details[PARTIAL_OBSERVATION_DELIVERY],
  ).toMatchObject({ retained: "not-retained" });
  expect(
    abortedReply.output.details.diagnostics?.evidence_bundle,
  ).toBeUndefined();
  expect((await stat(firstReceipt.path)).mtimeMs).toBe(beforeAborted);

  // Sensitive cache path is refused and never leaks into the failure output.
  const marked = "s3cr3t-fail-token";
  const sensitiveDir = join(root, marked, "evidence");
  const sensitiveReply = await publish({
    sensitiveValues: [marked],
    retentionDir: sensitiveDir,
  });
  expect(
    sensitiveReply.output.details[PARTIAL_OBSERVATION_DELIVERY],
  ).toMatchObject({ retained: "not-retained" });
  expect(
    sensitiveReply.output.details[PARTIAL_OBSERVATION_DELIVERY]
      ?.retention_failure,
  ).toEqual(expect.any(String));
  expect(JSON.stringify(sensitiveReply.output)).not.toContain(marked);
  expect(await files(join(root, marked))).toEqual([]);

  // Oversized bundle discarded after write withdraws the publication receipt.
  const tightDir = join(root, "tight-cache");
  const capBytes = Buffer.byteLength(JSON.stringify(inspected.value)) + 16;
  const discarded = await publish({ retentionDir: tightDir, capBytes });
  expect(discarded.output.details[PARTIAL_OBSERVATION_DELIVERY]).toMatchObject({
    retained: "not-retained",
  });
  expect(
    discarded.output.details[PARTIAL_OBSERVATION_DELIVERY]?.retention_failure,
  ).toContain("larger than");
  expect(discarded.receipt).toBeUndefined();
  expect(discarded.output.details.diagnostics?.evidence_bundle).toBeUndefined();
  expect(await files(tightDir)).toEqual([]);
});

it.each([false, true])(
  "retains the current captured source closure (failure=%s)",
  async (failed) => {
    const root = await createTestTempDirectory("rea-retain-source-closure-");
    const target = join(root, "bytes");
    await writeFile(target, randomBytes(1024 * 1024));
    const inspected = await createByteEntropyService().inspect({
      path: target,
      block_size: 256,
    });
    if (!inspected.ok) throw inspected.error;
    const complete = inspected.value;
    const source = createEvidence(
      unknownTarget("not-observed"),
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "source_fixture",
        parameters: {},
        result: {
          marker: "captured-source",
          nested: { alpha: 1, omega: 2 },
        },
      },
    );
    const firstSource = withEvidenceCallerInputPath(source, "./first-source");
    const secondSource = withEvidenceCallerInputPath(source, "./second-source");
    expect(firstSource.evidence_id).toBe(secondSource.evidence_id);
    const extra = createEvidence(
      unknownTarget("not-observed"),
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "source_fixture",
        parameters: {},
        result: { marker: "additional-source" },
      },
    );
    const directory = join(root, "cache");
    const publishResult = (
      sources: readonly Evidence[],
      evidenceOutput?: string,
    ) =>
      publishCliAnalysisEvidence(
        {
          ...(failed
            ? err({
                code: "provider_timeout",
                message: "Analysis timed out after partial work.",
                retryable: true,
                details: { partial_observation: complete },
              })
            : ok(complete)),
          sourceEvidence: sources,
        },
        {
          operation: "inspect_byte_entropy",
          signal: new AbortController().signal,
          detail: undefined,
          evidenceOutput,
        },
      );
    const deliver = (
      sources: readonly Evidence[],
      capBytes = 1024 * 1024 * 1024,
    ) =>
      withCliEvidencePublication(() => publishResult(sources), {
        retention: { directory, capBytes },
      });
    const publish = async (sources: readonly Evidence[]) => {
      const output = await deliver(sources);
      const receipt = failed
        ? (output as FailureOutput).details.diagnostics?.evidence_bundle
        : (output as unknown as Output).evidence_bundle;
      expect(receipt).toBeDefined();
      expect(receipt!.record_sha256).toBe(retainedEvidenceDigest(complete));
      return receipt!;
    };
    const read = async (path: string) =>
      parseEvidenceBundle(JSON.parse(await readFile(path, "utf8")));

    const first = await publish([firstSource]);
    expect((await read(first.path)).records).toContainEqual(firstSource);
    const second = await publish([secondSource]);
    expect(second.path).not.toBe(first.path);
    expect((await read(second.path)).records).toContainEqual(secondSource);
    expect((await read(second.path)).records).not.toContainEqual(firstSource);

    const expanded = await publish([secondSource, extra]);
    expect(expanded.path).not.toBe(second.path);
    expect((await read(expanded.path)).records).toEqual(
      expect.arrayContaining([complete, secondSource, extra]),
    );
    const before = await stat(expanded.path);
    const publishedBytes = await readFile(expanded.path);
    expect(basename(expanded.path, ".json")).toBe(
      createHash("sha256").update(publishedBytes).digest("hex"),
    );
    const reorderedSource = parseEvidence({
      ...secondSource,
      normalized_result: {
        nested: { omega: 2, alpha: 1 },
        marker: "captured-source",
      },
    });
    expect(reorderedSource.evidence_id).toBe(secondSource.evidence_id);
    expect(JSON.stringify(reorderedSource)).not.toBe(
      JSON.stringify(secondSource),
    );
    const reordered = await publish([extra, reorderedSource]);
    expect(reordered).toEqual(expanded);
    expect((await stat(reordered.path)).ino).toBe(before.ino);
    expect((await readFile(reordered.path)).equals(publishedBytes)).toBe(true);

    // The same record may fit the parent budget but exceed a later cache cap
    // once its retained source records are counted.
    const smallerCap = expanded.bytes - 1;
    expect(smallerCap).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(complete)),
    );
    const lastUsed = new Date("2026-01-01T00:00:00Z");
    await utimes(expanded.path, lastUsed, lastUsed);
    const declined = await deliver([secondSource, extra], smallerCap);
    const failedDetails = (declined as FailureOutput).details;
    const delivery = failed
      ? failedDetails[PARTIAL_OBSERVATION_DELIVERY]
      : (declined as unknown as Output).delivery;
    expect(delivery).toMatchObject({
      retained: "not-retained",
      retention_failure: expect.stringContaining("larger than"),
    });
    expect(
      failed
        ? failedDetails.diagnostics?.evidence_bundle
        : (declined as unknown as Output).evidence_bundle,
    ).toBeUndefined();
    expect((await stat(expanded.path)).mtimeMs).toBe(lastUsed.getTime());
    expect((await readFile(expanded.path)).equals(publishedBytes)).toBe(true);

    await withCliEvidencePublication(
      async () => {
        const earlierPath = join(root, "earlier-publication.json");
        await publishResult([firstSource], earlierPath);
        const earlierReceipt = cliEvidencePublicationReceipt();
        expect(earlierReceipt).toBeDefined();
        const earlierBytes = await readFile(earlierPath);
        const rejected = await publishResult([secondSource, extra]);
        const rejectedDelivery = failed
          ? (rejected as FailureOutput).details[PARTIAL_OBSERVATION_DELIVERY]
          : (rejected as unknown as Output).delivery;
        expect(rejectedDelivery).toMatchObject({ retained: "not-retained" });
        expect(cliEvidencePublicationReceipt()).toBe(earlierReceipt);
        const outputFailure = retainCliPublicationOnError(
          new AnalysisInputError("inspect_byte_entropy", {
            userMessage: "Later output formatting failed.",
          }),
        );
        expect(outputFailure.diagnostics?.evidence_bundle).toEqual(
          earlierReceipt,
        );
        expect((await readFile(earlierPath)).equals(earlierBytes)).toBe(true);
        expect((await readFile(expanded.path)).equals(publishedBytes)).toBe(
          true,
        );
        expect((await stat(expanded.path)).mtimeMs).toBe(lastUsed.getTime());
      },
      { retention: { directory, capBytes: smallerCap } },
    );
  },
);

it("delivers an unretained over-budget extraction complete, since a rerun cannot reproduce it", async () => {
  const { serve } = await workspace();
  const root = await createTestTempDirectory("rea-retain-extraction-");
  const archive = join(root, "app.zip");
  await writeOrderedZip(
    archive,
    Array.from({ length: 400 }, (_, index) => `res/item${String(index)}.txt`),
  );
  const extract = (output: string, ...flags: string[]) =>
    serve([
      "extract-artifact",
      archive,
      "--output-root",
      join(root, output),
      "--json",
      ...flags,
    ]);
  // The extraction created its output root, so rerunning it fails; its
  // complete record is the only recovery.
  const unretained = parseEvidence(await extract("unretained", "--no-retain"));
  expect(unretained.operation).toBe("extract_artifact");
  expect(
    (unretained.normalized_result as { artifacts: unknown[] }).artifacts,
  ).toHaveLength(400);
  // With the cache on, the summary stays and pages the retained record.
  const retained = (await extract("retained")) as Output;
  expect(parseEvidence(retained.summary).operation).toBe(
    "inspect_analysis_view",
  );
  expect(retained.delivery).toMatchObject({ retained: "cache-file" });
});
