import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";

import { describe, expect, it } from "vitest";

import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { guestFileAnswerBytes } from "./AgentEnvComputer.js";
import {
  fetchHomeFolder,
  LINUX_ARGUMENT_VECTOR_BYTES,
  runBuildController,
} from "./BuildComputerController.js";

const MIB = 1024 * 1024;
const EXPECTED_LINUX_SINGLE_ARGUMENT_BYTES = 32 * 4096 - 1;
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** A computer whose controller lists `files` into a file beside the folder and whose data/get answers them, noting each fetch of a file. */
const computer = (files: ReadonlyMap<string, Buffer>, steps: string[]) => {
  const listing = Buffer.from(
    JSON.stringify({
      files: [...files].map(([path, bytes]) => ({
        path,
        size: bytes.length,
        sha256: sha256(bytes),
      })),
      skipped: [],
    }),
  );
  return {
    exec: () =>
      Promise.resolve({
        exit_code: 0,
        stdout: `${JSON.stringify({ listing_bytes: listing.length })}\n`,
        stderr: "",
        truncated: false,
        timed_out: false,
      }),
    redacted: (text: string) => text,
    homeFiles: (paths: readonly string[], bytes: number) => {
      if (paths[0]?.endsWith(".listing.json") === true)
        return Promise.resolve(new Map([[paths[0], listing]]));
      steps.push(`get ${paths.join(",")} within ${String(bytes)}`);
      return Promise.resolve(
        new Map(
          paths.map((path) => [path, files.get(path) ?? Buffer.alloc(0)]),
        ),
      );
    },
  };
};

describe("fetchHomeFolder", () => {
  it("splits tiny files before their answer envelopes exceed the live budget", async () => {
    const workingBytes = Math.floor(getHeapStatistics().heap_size_limit / 12);
    const count = Math.floor(workingBytes / (64 * 1024)) + 2;
    const files = new Map(
      Array.from({ length: count }, (_, index) => [
        `.rea-build/b/file-${String(index)}`,
        Buffer.from("x"),
      ]),
    );
    const base = computer(files, []);
    const batches: { count: number; bytes: number }[] = [];
    const observed = {
      ...base,
      homeFiles: (paths: readonly string[], bytes: number) => {
        if (paths[0]?.endsWith(".listing.json") !== true)
          batches.push({ count: paths.length, bytes });
        return base.homeFiles(paths, bytes);
      },
    };
    const result = await fetchHomeFolder(observed, ".rea-build/b", {
      file: () => Promise.resolve(),
    });
    expect(result).toEqual({ files: count, bytes: count });
    expect(batches.length).toBeGreaterThan(1);
    expect(
      batches.every(
        ({ count, bytes }) =>
          guestFileAnswerBytes(bytes, count) <= workingBytes,
      ),
    ).toBe(true);
  });

  it("hands over each checked batch before asking for the next, so one batch at a time is held", async () => {
    const files = new Map([
      [".rea-build/b/a", Buffer.alloc(5 * MIB, 1)],
      [".rea-build/b/b", Buffer.alloc(4 * MIB, 2)],
      [".rea-build/b/c", Buffer.alloc(1 * MIB, 3)],
    ]);
    const steps: string[] = [];
    await fetchHomeFolder(computer(files, steps), ".rea-build/b", {
      file: (file) => {
        steps.push(`write ${file.path}`);
        return Promise.resolve();
      },
    });
    expect(steps).toEqual([
      `get .rea-build/b/a within ${String(5 * MIB)}`,
      "write a",
      `get .rea-build/b/b,.rea-build/b/c within ${String(5 * MIB)}`,
      "write b",
      "write c",
    ]);
  });

  it("refuses a file that differs from its listing before handing it over", async () => {
    const files = new Map([[".rea-build/b/a", Buffer.from("seed")]]);
    const steps: string[] = [];
    const base = computer(files, steps);
    const changed = {
      ...base,
      homeFiles: (paths: readonly string[], bytes: number) =>
        paths[0] === ".rea-build/b/a"
          ? Promise.resolve(new Map([[".rea-build/b/a", Buffer.from("SEED")]]))
          : base.homeFiles(paths, bytes),
    };
    await expect(
      fetchHomeFolder(changed, ".rea-build/b", {
        file: () => {
          steps.push("write");
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/differs from its listing/u);
    expect(steps).toEqual([]);
  });
});

describe("controller arguments", () => {
  it("splits a full start request so each argument fits Linux and the pieces join back", async () => {
    const launchArguments = Array.from({ length: 32 }, () => "a".repeat(4096));
    const payload = {
      work: ".rea-build",
      capture: ".rea-build/capture",
      desktop_entry: "notes.desktop",
      arguments: launchArguments,
      state_paths: [] as string[],
      timeout_s: 120,
      apt_timeout_s: 600,
    };
    let argv: readonly string[] = [];
    await runBuildController(
      {
        exec: (next) => {
          argv = next;
          return Promise.resolve({
            exit_code: 0,
            stdout: "{}\n",
            stderr: "",
            truncated: false,
            timed_out: false,
          });
        },
        homeFiles: () => Promise.resolve(new Map()),
        redacted: (text) => text,
      },
      "start",
      payload,
      { timeoutS: 1 },
    );
    expect(argv.slice(0, 5)).toEqual([
      "python3",
      "-I",
      "-c",
      expect.any(String),
      "start",
    ]);
    for (const argument of argv)
      expect(Buffer.byteLength(argument)).toBeLessThanOrEqual(
        EXPECTED_LINUX_SINGLE_ARGUMENT_BYTES,
      );
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(
      EXPECTED_LINUX_SINGLE_ARGUMENT_BYTES,
    );
    expect(JSON.parse(argv.slice(5).join(""))).toEqual(payload);
  });

  it("refuses a request whose arguments together exceed Linux's command limit", async () => {
    let called = false;
    const payload = { prompt: "a".repeat(LINUX_ARGUMENT_VECTOR_BYTES) };
    await expect(
      runBuildController(
        {
          exec: () => {
            called = true;
            return Promise.resolve({
              exit_code: 0,
              stdout: "{}\n",
              stderr: "",
              truncated: false,
              timed_out: false,
            });
          },
          homeFiles: () => Promise.resolve(new Map()),
          redacted: (text) => text,
        },
        "run",
        payload,
        { timeoutS: 1 },
      ),
    ).rejects.toMatchObject({
      _tag: "AnalysisResourceConstraintError",
      resource: "transport",
      reportedLimits: {
        actual_bytes: expect.any(Number),
        max_bytes: LINUX_ARGUMENT_VECTOR_BYTES,
      },
      remediationAction: expect.any(String),
    } satisfies Partial<AnalysisResourceConstraintError>);
    expect(called).toBe(false);
  });

  it("keeps a character split on a UTF-16 pair whole and joins the controller's real entry point", async () => {
    const text = `${"a".repeat(EXPECTED_LINUX_SINGLE_ARGUMENT_BYTES - 12)}\u{1F600}rest`;
    const input = { text };
    let argv: readonly string[] = [];
    await runBuildController(
      {
        exec: (next) => {
          argv = next;
          return Promise.resolve({
            exit_code: 0,
            stdout: "{}\n",
            stderr: "",
            truncated: false,
            timed_out: false,
          });
        },
        homeFiles: () => Promise.resolve(new Map()),
        redacted: (value) => value,
      },
      "start",
      input,
      { timeoutS: 1 },
    );
    const pieces = argv.slice(5);
    expect(JSON.parse(pieces.join(""))).toEqual(input);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(Buffer.byteLength(piece)).toBeLessThanOrEqual(
        EXPECTED_LINUX_SINGLE_ARGUMENT_BYTES,
      );
      expect(Buffer.from(piece, "utf8").toString("utf8") === piece).toBe(true);
    }
    const root = await mkdtemp(join(tmpdir(), "rea-controller-args-"));
    try {
      const output = join(root, "listing.json");
      const payload = JSON.stringify({ root, output });
      const mid = Math.floor(payload.length / 2);
      const script = fileURLToPath(
        new URL("../../bridge/agentenv/capture.py", import.meta.url),
      );
      const stdout = execFileSync(
        "python3",
        ["-I", "-B", script, "list", payload.slice(0, mid), payload.slice(mid)],
        { encoding: "utf8" },
      );
      const answer: unknown = JSON.parse(
        stdout.trim().split("\n").at(-1) ?? "",
      );
      expect(answer).toMatchObject({
        listing_bytes: expect.any(Number),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
