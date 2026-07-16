import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const fixture = async (name: string): Promise<string> =>
  readFile(resolve("tests/fixtures/replay", name), "utf8");

const runWorker = async (request: unknown) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolvePromise, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--experimental-vm-modules",
          resolve("dist/replay/JavaScriptReplayWorker.js"),
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(request));
    },
  );

const request = async (
  name: string,
  format: "esm" | "commonjs-factory",
  entryExport: string,
  arguments_: readonly unknown[],
) => ({
  schemaVersion: 1,
  left: {
    modules: [
      {
        alias: "entry",
        format,
        dependencies: {},
        source: await fixture(name),
      },
    ],
    entryAlias: "entry",
    entryExport,
  },
  cases: [
    {
      caseId: "case",
      arguments: arguments_,
      inputSha256: "a".repeat(64),
    },
  ],
  determinism: {
    clockIso: "2000-01-01T00:00:00.000Z",
    randomSeed: 7,
  },
  limits: { resultDepth: 16, resultNodes: 10_000, exceptionBytes: 4096 },
});

describe("disposable JavaScript replay worker", () => {
  it("runs an ESM parser with projected plain data", async () => {
    const result = await runWorker(
      await request("parser.mjs", "esm", "default", ["# Title"]),
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      left: [
        {
          outcome: "return",
          value: { type: "heading", text: "Title" },
        },
      ],
    });
  });

  it("supports extracted Rspack factories and helper-defined exports", async () => {
    const result = await runWorker(
      await request("clipboard.factory.txt", "commonjs-factory", "normalize", [
        "a\r\nb",
      ]),
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      left: [
        {
          outcome: "return",
          value: { text: "a\nb", bytes: 4 },
        },
      ],
    });
  });

  it("runs the source-owned sanitizer fixture", async () => {
    const result = await runWorker(
      await request("sanitizer.factory.txt", "commonjs-factory", "sanitize", [
        "<script>alert(1)</script><b onclick=bad>ok</b>",
      ]),
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      left: [{ outcome: "return", value: "<b>ok</b>" }],
    });
  });

  it("denies dynamic imports and undeclared requires", async () => {
    const dynamic = await runWorker(
      await request("dynamic-import.mjs", "esm", "default", []),
    );
    expect(JSON.parse(dynamic.stdout)).toMatchObject({
      left: [
        {
          outcome: "denied",
          exception: {
            message: "Dynamic import is unavailable in controlled replay",
          },
        },
      ],
    });
    const undeclared = await runWorker(
      await request(
        "undeclared-require.factory.txt",
        "commonjs-factory",
        "default",
        [],
      ),
    );
    expect(JSON.parse(undeclared.stdout)).toMatchObject({
      left: [
        {
          outcome: "denied",
          exception: { message: "Undeclared require: node:fs" },
        },
      ],
    });
  });

  it("retains exceptions as observations", async () => {
    const result = await runWorker(
      await request("exception.mjs", "esm", "default", ["value"]),
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      left: [
        {
          outcome: "exception",
          exception: { name: "TypeError", message: "fixture:value" },
        },
      ],
    });
  });

  it("rejects Proxy results without invoking descriptor traps", async () => {
    const result = await runWorker(
      await request("proxy-result.mjs", "esm", "default", []),
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      left: [
        {
          outcome: "serialization_error",
          exception: {
            name: "TypeError",
            message: "Proxy replay results are unavailable",
          },
        },
      ],
    });
    expect(result.stderr).not.toContain("proxy trap must not run");
  });

  it("does not expose ambient process, require, network, buffers, or timers", async () => {
    const result = await runWorker(
      await request("side-effect-attempt.mjs", "esm", "default", []),
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      left: [
        {
          outcome: "return",
          value: {
            process: "undefined",
            require: "undefined",
            fetch: "undefined",
            buffer: "undefined",
            timer: "undefined",
          },
        },
      ],
    });
  });
});
