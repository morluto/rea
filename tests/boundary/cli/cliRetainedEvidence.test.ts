import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

import { inspectAnalysisView } from "../../../src/application/analysisView/AnalysisViewService.js";
import { createCli } from "../../../src/cli.js";
import {
  cliRetainedEvidenceDirectory,
  retainCliEvidence,
} from "../../../src/cli/cliEvidenceRetention.js";
import { CLI_RETAINED_EVIDENCE_MAX_AGE_MS } from "../../../src/domain/analysisResourceLimits.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

type Output = {
  readonly summary: unknown;
  readonly evidence_bundle?: { readonly path: string; readonly bytes: number };
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
  const run = async (...flags: string[]): Promise<Output> => {
    let stdout = "";
    let exitCode = 0;
    await createCli(environment).serve(
      [
        "inspect-byte-entropy",
        target,
        "--block-size",
        "256",
        "--json",
        ...flags,
      ],
      {
        env: environment,
        exit: (code) => {
          exitCode = code;
        },
        stdout: (text) => {
          stdout += text;
        },
      },
    );
    expect(exitCode, stdout).toBe(0);
    return JSON.parse(stdout) as Output;
  };
  return { run, directory, target };
};

const files = (directory: string) =>
  readdir(directory).catch((cause: unknown) => {
    if ((cause as { code?: string }).code === "ENOENT") return [];
    throw cause;
  });

it("keeps an over-budget CLI result in the private cache, pages it, and reuses it", async () => {
  const { run, directory } = await workspace();
  const first = await run();
  expect(parseEvidence(first.summary).operation).toBe("inspect_analysis_view");
  const id = first.delivery.evidence_id;
  const path = join(directory, `${id}.json`);
  expect(first.delivery).toMatchObject({ retained: "cache-file" });
  expect(first.evidence_bundle).toEqual({
    path,
    bytes: (await stat(path)).size,
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
  expect(await files(directory)).toEqual([`${id}.json`]);
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
    const name = `ev_${digit.repeat(64)}.json`;
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
      evidenceId: `ev_${digit.repeat(64)}`,
      completeBytes: 400,
      retention: { directory, capBytes },
      now,
      write: async (path) => {
        await writeFile(path, "y".repeat(400), { flag: "wx", mode: 0o600 });
        return ok({ bytes: 400 });
      },
    });
  const named = (digit: string) => `ev_${digit.repeat(64)}.json`;

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
});
