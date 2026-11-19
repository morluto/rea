import { expect, it } from "vitest";

import { WebBundleAnalysisWorker } from "../../../src/browser/WebBundleAnalysisWorker.js";
import {
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "../../../src/domain/analysisErrorCore.js";
import type { JavaScriptArtifactFile } from "../../../src/domain/javascript/javascriptArtifactFiles.js";
import { createWebTextArtifact } from "../../../src/domain/webContentArtifact.js";
import type { IncludedScript } from "../../../src/domain/webBundleAnalyzerState.js";
import { JavaScriptAnalysisWorker } from "../../../src/javascript/analysis/JavaScriptAnalysisWorker.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";

const source = createWebTextArtifact(
  "export const observed = 1;",
  "application/javascript",
);
const file: JavaScriptArtifactFile = {
  path: "app.mjs",
  sha256: source.sha256,
  container_sha256: "1".repeat(64),
  bytes: source.bytes,
  inventory_artifact_id: "fixture-source",
  kind: "javascript",
  unpacked: false,
  text: { included: true, value: source.text },
};
const script: IncludedScript = {
  script_key: `scr_${source.sha256}`,
  frame_id: "fixture",
  url: "https://app.example.test/app.js",
  origin: "https://app.example.test",
  cdp_hash: null,
  length: source.bytes,
  is_module: true,
  language: "JavaScript",
  source_map_url: null,
  resource_reconciliation: {
    status: "unmatched",
    reason: "no_exact_sanitized_url",
  },
  source: { included: true, artifact: source },
};

type WorkerKind = "web" | "javascript";
type Encoding = "malformed" | "replacement" | "bom" | "non-json-whitespace";

const launchFor =
  (kind: WorkerKind, encoding: Encoding): typeof spawnOwnedProviderProcess =>
  (request) =>
    spawnOwnedProviderProcess({
      ...request,
      arguments: [
        ...request.arguments.slice(0, -1),
        "-e",
        `
const { getHeapStatistics } = require("node:v8");
const { createInterface } = require("node:readline");
process.stdout.write(JSON.stringify({kind:"ready",heap_limit_bytes:getHeapStatistics().heap_size_limit})+"\\n");
createInterface({ input: process.stdin }).once("line", (line) => {
  const { id } = JSON.parse(line);
  const encoding = ${JSON.stringify(encoding)};
  const frame = {
    kind: "failure", id, reason: "resource", message: "reported WIRE_VALUE",
    ${kind === "javascript" ? 'resource:"memory", limits:null,' : ""}
  };
  const [before, after] = JSON.stringify(frame).split("WIRE_VALUE");
  const marker = encoding === "malformed" ? Buffer.from([0xff]) : Buffer.from("\\ufffd");
  const prefix = encoding === "bom" ? "\\ufeff" : encoding === "non-json-whitespace" ? "\\u00a0" : "";
  process.stdout.write(Buffer.concat([Buffer.from(prefix + before), marker, Buffer.from(after + "\\n")]));
});
`,
      ],
    });

const analyze = async (kind: WorkerKind, encoding: Encoding) => {
  const launch = launchFor(kind, encoding);
  if (kind === "web") {
    const worker = new WebBundleAnalysisWorker(128, launch);
    try {
      return await worker.analyze(script, 10_000);
    } finally {
      await worker.close();
    }
  }
  const worker = new JavaScriptAnalysisWorker(
    { heapMb: 128, timeoutMs: 10_000 },
    launch,
  );
  try {
    return await worker.analyze(file, { nodes: 100, unknowns: 100 });
  } finally {
    await worker.close();
  }
};

it.each([
  ["web", "malformed"],
  ["javascript", "malformed"],
  ["web", "replacement"],
  ["javascript", "replacement"],
  ["web", "bom"],
  ["javascript", "bom"],
  ["web", "non-json-whitespace"],
  ["javascript", "non-json-whitespace"],
] as const)(
  "%s distinguishes %s control bytes from a valid resource fact",
  async (kind, encoding) => {
    const result = await analyze(kind, encoding);
    if (result.ok) throw new Error("Expected the fixture's worker failure");
    if (encoding === "replacement") {
      expect(result.error.error).toBeInstanceOf(
        AnalysisResourceConstraintError,
      );
      expect(result.error.error.message).toContain("reported \ufffd");
    } else expect(result.error.error).toBeInstanceOf(AnalysisOutputError);
  },
);
