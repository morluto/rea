import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { expect, it } from "vitest";

import { inspectAnalysisView } from "../../../src/application/analysisView/AnalysisViewService.js";
import { createCli } from "../../../src/cli.js";
import { publishCliAnalysisEvidence } from "../../../src/cli/analysisEvidenceDelivery.js";
import {
  cliEvidencePublicationReceipt,
  withCliEvidencePublication,
} from "../../../src/cli/cliEvidencePublication.js";
import {
  cliRetainedEvidenceDirectory,
  retainCliEvidence,
  retainedEvidenceDigest,
} from "../../../src/cli/cliEvidenceRetention.js";
import { createByteEntropyService } from "../../../src/composition/binaryDiagnostics/byteEntropy.js";
import { CLI_RETAINED_EVIDENCE_MAX_AGE_MS } from "../../../src/domain/analysisResourceLimits.js";
import {
  parseEvidence,
  withEvidenceCallerInputPath,
} from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { HOST_PLATFORM } from "../../../src/platform/HostPlatform.js";
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
  const path = join(await realpath(directory), `${sha256}.json`);
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
  // The file is named by the digest of the complete record's exact JSON.
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
  expect(await files(directory)).toEqual([`${sha256}.json`]);

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
    [`${sha256}.json`, `${spelled.evidence_bundle!.record_sha256}.json`].sort(),
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
      sha256: digit.repeat(64),
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
    sha256: "f".repeat(64),
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
        sha256: "9".repeat(64),
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
      sha256: "e".repeat(64),
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
