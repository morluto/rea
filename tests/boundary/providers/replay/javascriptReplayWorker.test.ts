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

it("uses the caller's full output budget for exception text", async () => {
  const message = "x".repeat(70_000);
  const workerRequest = await request("exception.mjs", "esm", "default", [
    message,
  ]);
  workerRequest.limits.exceptionBytes = 80_000;
  const result = await runWorker(workerRequest);

  expect(result.code).toBe(0);
  const response = JSON.parse(result.stdout) as {
    readonly left: readonly {
      readonly exception: { readonly message: string };
    }[];
  };
  expect(response.left[0]?.exception.message).toBe(`fixture:${message}`);
});

describe("disposable JavaScript replay worker", () => {
  it("rejects malformed runtime-hop requests before loading modules", async () => {
    const result = await runWorker({
      left: { modules: "not-an-array", entryAlias: "entry", entryExport: "x" },
      cases: [],
      determinism: { clockIso: "2000-01-01T00:00:00.000Z", randomSeed: 7 },
      limits: { resultDepth: 16, resultNodes: 10_000, exceptionBytes: 4096 },
    });

    expect(result.code).toBe(70);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Invalid replay worker modules");
  });

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

describe("deterministic replay Date compatibility", () => {
  it.each([
    ["new Date(2020, 0, 2).getFullYear()", 2020],
    ["new Date(2020, 0, 2, 3, 4, 5, 6).getMilliseconds()", 6],
    ["typeof Date()", "string"],
    ["Date() === new Date().toString()", true],
    ["new Date().toISOString()", "2000-01-01T00:00:00.000Z"],
    ["Date.now()", 946684800000],
    ["new Date(0).getTime()", 0],
    [
      "new Date('2020-01-02T00:00:00Z').toISOString()",
      "2020-01-02T00:00:00.000Z",
    ],
    ["new Date() instanceof Date", true],
    [
      "(() => { class ChildDate extends Date {} const date = new ChildDate(2020, 0, 2); return [date instanceof ChildDate, date instanceof Date, date.getFullYear(), date.constructor === ChildDate]; })()",
      [true, true, 2020, true],
    ],
    ["Date.UTC(2020, 0, 2)", 1577923200000],
  ])("preserves %s", async (expression, expected) => {
    const workerRequest = await request("parser.mjs", "esm", "default", []);
    workerRequest.left.modules[0] = {
      alias: "entry",
      format: "esm",
      dependencies: {},
      source: `export default function () { return ${expression}; }`,
    };
    const result = await runWorker(workerRequest);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      left: [{ outcome: "return", value: expected }],
    });
  });
});

describe("replay array projection", () => {
  it.each([
    ["Array(3)", [null, null, null]],
    [
      "(() => { const value = Array(3); value[1] = 42; return value; })()",
      [null, 42, null],
    ],
    ["[1, null, 3]", [1, null, 3]],
    ["[]", []],
  ])("preserves JSON array positions for %s", async (expression, expected) => {
    const workerRequest = await request("parser.mjs", "esm", "default", []);
    workerRequest.left.modules[0] = {
      alias: "entry",
      format: "esm",
      dependencies: {},
      source: `export default function () { return ${expression}; }`,
    };
    const result = await runWorker(workerRequest);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      left: [{ outcome: "return", value: expected }],
    });
  });

  it("accounts for holes in the existing result node budget", async () => {
    const workerRequest = await request("parser.mjs", "esm", "default", []);
    workerRequest.left.modules[0] = {
      alias: "entry",
      format: "esm",
      dependencies: {},
      source: "export default function () { return Array(4); }",
    };
    workerRequest.limits.resultNodes = 3;
    const result = await runWorker(workerRequest);
    expect(JSON.parse(result.stdout)).toMatchObject({
      left: [
        {
          outcome: "serialization_error",
          exception: { message: "Replay result projection limit exceeded" },
        },
      ],
    });
  });
});
