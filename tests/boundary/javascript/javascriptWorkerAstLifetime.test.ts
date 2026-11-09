import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";

const SOURCE = `
import { ipcRenderer } from "electron";
export function sendPing(payload) {
  return ipcRenderer.invoke("ping", payload);
}
`;
const DIGEST = createHash("sha256").update(SOURCE).digest("hex");

const SCRIPT = String.raw`
import assert from "node:assert/strict";
import { parseJavaScriptSource } from "./src/domain/javascript/javascriptSourceParser.ts";
import { analyzeParsedJavaScriptStaticSourceWithBindingsSteps } from "./src/domain/javascript/javascriptStaticAnalysis.ts";
import { createJavaScriptSourceWorkerAnalyzer } from "./src/composition/javascriptAnalysisWorkerAnalyzer.ts";

let programRef;
let bindingsRef;

const analyze = createJavaScriptSourceWorkerAnalyzer({
  parseSource: (text, path, packageType) => {
    const parsed = parseJavaScriptSource(text, path, packageType);
    if (parsed !== null) programRef = new WeakRef(parsed.program);
    return parsed;
  },
  analyzeStaticWithBindings: function* (text, parsed, mode) {
    const result = yield* analyzeParsedJavaScriptStaticSourceWithBindingsSteps(
      text,
      parsed,
      mode,
    );
    bindingsRef = new WeakRef(result.bindings);
    return result;
  },
});

const source = process.env.REA_TEST_JS_SOURCE;
const digest = process.env.REA_TEST_JS_DIGEST;
let bindingsCollectedBeforeProjection = false;
let programCollectedBeforeProjection = false;

const outcome = await analyze(
  {
    path: "renderer.mjs",
    sha256: digest,
    container_sha256: digest,
    bytes: Buffer.byteLength(source),
    inventory_artifact_id: "worker-lifetime-test",
    origin: "direct",
    text: { included: true, value: source },
  },
  { unknowns: 1000, nodes: 10_000 },
  {
    checkpoint: async () => 1024 * 1024,
    phase: async (phase) => {
      if (phase !== "projection") return;
      for (let i = 0; i < 8; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        globalThis.gc();
      }
      bindingsCollectedBeforeProjection = bindingsRef?.deref() === undefined;
      programCollectedBeforeProjection = programRef?.deref() === undefined;
    },
  },
  "module",
  "analysis",
);

assert.notEqual(outcome, null);
assert.equal(
  bindingsCollectedBeforeProjection,
  true,
  "Receiver index remained reachable during semantic projection",
);
assert.equal(
  programCollectedBeforeProjection,
  true,
  "Parsed AST remained reachable during semantic projection",
);
`;

it.skipIf(process.platform === "win32")(
  "releases the static receiver index and parsed AST before semantic projection",
  () => {
    const result = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        SCRIPT,
      ],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          PATH: process.env.PATH,
          REA_TEST_JS_SOURCE: SOURCE,
          REA_TEST_JS_DIGEST: DIGEST,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  },
);
