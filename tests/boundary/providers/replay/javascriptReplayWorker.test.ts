import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

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

describe("ESM imports of CommonJS replay factories", () => {
  it.each([false, true])(
    "matches native Node default import when __esModule is %s",
    async (marked) => {
      const directory = await createTestTempDirectory("rea-replay-interop-");
      const source = `module.exports={default:'named-default',answer:42,__esModule:${String(marked)}};`;
      const path = join(directory, "dependency.cjs");
      await writeFile(path, source, "utf8");
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          "const {default:value}=await import(process.argv[1]); console.log(JSON.stringify({kind:typeof value,property:value.default,answer:value.answer}));",
          pathToFileURL(path).href,
        ],
        { timeout: 5000 },
      );
      const expected: unknown = JSON.parse(stdout);
      expect(expected).toEqual({
        kind: "object",
        property: "named-default",
        answer: 42,
      });
      const workerRequest = await request("parser.mjs", "esm", "default", []);
      workerRequest.left.modules = [
        {
          alias: "entry",
          format: "esm",
          dependencies: { "./dependency": "dependency" },
          source:
            "import value from './dependency'; export default function(){ return {kind:typeof value,property:value.default,answer:value.answer}; }",
        },
        {
          alias: "dependency",
          format: "commonjs-factory",
          dependencies: {},
          source: `function(module){ ${source} }`,
        },
      ];
      const result = await runWorker(workerRequest);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        left: [{ outcome: "return", value: expected }],
      });
    },
  );

  it.each([false, true])(
    "preserves Rspack require.n behavior when __esModule is %s",
    async (marked) => {
      const workerRequest = await request(
        "clipboard.factory.txt",
        "commonjs-factory",
        "default",
        [],
      );
      workerRequest.left.modules = [
        {
          alias: "entry",
          format: "commonjs-factory",
          dependencies: { "./dependency": "dependency" },
          source:
            "function(module,exports,require){ const normalized=require.n(require('./dependency'))(); module.exports.default=()=>typeof normalized; }",
        },
        {
          alias: "dependency",
          format: "commonjs-factory",
          dependencies: {},
          source: `function(module){ module.exports={default:'named-default',answer:42,__esModule:${String(marked)}}; }`,
        },
      ];
      const result = await runWorker(workerRequest);
      expect(JSON.parse(result.stdout)).toMatchObject({
        left: [{ outcome: "return", value: marked ? "string" : "object" }],
      });
    },
  );

  it("preserves direct factory default-export selection", async () => {
    const workerRequest = await request(
      "clipboard.factory.txt",
      "commonjs-factory",
      "default",
      [],
    );
    workerRequest.left.modules[0] = {
      alias: "entry",
      format: "commonjs-factory",
      dependencies: {},
      source: "function(module){ module.exports={default:()=>42}; }",
    };
    const result = await runWorker(workerRequest);
    expect(JSON.parse(result.stdout)).toMatchObject({
      left: [{ outcome: "return", value: 42 }],
    });
  });
});
