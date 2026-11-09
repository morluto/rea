import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { guestFileAnswerBytes } from "./AgentEnvComputer.js";
import {
  batchListedFiles,
  controllerArgumentPieces,
  fetchHomeFolder,
  LINUX_ARGUMENT_VECTOR_BYTES,
  LINUX_SINGLE_ARGUMENT_BYTES,
  runBuildController,
} from "./BuildComputerController.js";

const MIB = 1024 * 1024;
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

describe("batchListedFiles", () => {
  it("starts another batch before each file's envelope pushes the answer over the budget", () => {
    const files = [1, 2, 3].map((index) => ({
      path: `f${String(index)}`,
      size: 10,
    }));
    const budget = guestFileAnswerBytes(20, 2);
    expect(
      batchListedFiles(files, {
        rawBytes: 8 * 1024 * 1024,
        answerBytes: budget,
      }).map((batch) => batch.files.length),
    ).toEqual([2, 1]);
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
        LINUX_SINGLE_ARGUMENT_BYTES,
      );
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(
      LINUX_SINGLE_ARGUMENT_BYTES,
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
    const text = `${"a".repeat(LINUX_SINGLE_ARGUMENT_BYTES - 1)}\u{1F600}rest`;
    const pieces = controllerArgumentPieces(text);
    expect(pieces.join("")).toBe(text);
    for (const piece of pieces)
      expect(Buffer.byteLength(piece)).toBeLessThanOrEqual(
        LINUX_SINGLE_ARGUMENT_BYTES,
      );
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

describe("batchListedFiles", () => {
  it("splits many tiny files before their envelopes pass the answer budget", () => {
    const files = Array.from({ length: 3000 }, (_, index) => ({
      path: `home/file-${String(index)}`,
      size: 1,
    }));
    const answerBytes = guestFileAnswerBytes(1, 1);
    const batches = batchListedFiles(files, {
      rawBytes: 8 * MIB,
      answerBytes,
    });

    expect(batches.length).toBe(files.length);
    expect(
      batches.every(
        (batch) =>
          guestFileAnswerBytes(batch.bytes, batch.files.length) <= answerBytes,
      ),
    ).toBe(true);
  });
});
