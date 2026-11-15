#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createEvidenceBundle } from "../../dist/domain/evidenceBundle.js";
import { parseEvidence } from "../../dist/domain/evidence.js";
import { withVerifierCleanup } from "../lib/verifier-cleanup.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(root, "scripts", "rea.mjs");

// Both pages belong to this example. No target or browser is downloaded.
const page = (
  count,
) => `<!doctype html><meta charset="utf-8"><title>Save fixture</title>
<style>body{margin:0;background:#fff;color:#142030;font:16px Arial}main{padding:32px}button{font:inherit;padding:12px 24px}p{height:24px}</style>
<main><h1>Settings</h1><button id="save">Save</button><p id="status">Ready</p></main>
<script>document.querySelector('#save').onclick=()=>{document.querySelector('#status').textContent='Saved';console.info('saved-count=${count}');};</script>`;

export async function site(count) {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(page(count));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export const scenario = (browser, origin) => ({
  browser: { mode: "launch", executable_path: browser, headless: true },
  start_url: { url: `${origin}/` },
  environment: {
    viewport: { width: 800, height: 500, device_scale_factor: 1 },
    locale: "en-US",
    timezone: "UTC",
    color_scheme: "light",
    reduced_motion: "reduce",
  },
  actions: [
    {
      step_id: "save",
      action: "click",
      timeout_ms: 10_000,
      locator: { kind: "role", role: "button", name: "Save" },
    },
  ],
  capture: {
    after_each_step: ["screenshot", "dom", "url"],
    at_end: ["screenshot", "dom", "url"],
    events: ["console"],
  },
});

export const specification = (capture, pixels) => ({
  name: "Save fixture reconstruction",
  claims: [
    {
      claim_id: "save-appearance",
      title: "Saved screen has identical pixels",
      kind: "web-screenshot",
      comparison_evidence_id: pixels.evidence_id,
      dimension: "pixels",
      maximum_changed_ratio: 0,
    },
    {
      claim_id: "save-count",
      title: "Save reports the same count",
      kind: "web-scenario",
      comparison_evidence_id: capture.evidence_id,
      dimension: "events",
      step_id: "save",
    },
    {
      claim_id: "save-storage",
      title: "Save preserves storage",
      kind: "web-scenario",
      comparison_evidence_id: capture.evidence_id,
      dimension: "storage",
      step_id: "save",
    },
  ],
});

function exampleArguments() {
  const [browser, output, mode] = process.argv.slice(2);
  if (
    !browser ||
    !output ||
    !isAbsolute(browser) ||
    !isAbsolute(output) ||
    (mode !== undefined && mode !== "--matching")
  )
    throw new Error(
      "Usage: node scripts/examples/web-reconstruction.mjs ABSOLUTE_BROWSER_PATH NEW_ABSOLUTE_OUTPUT_DIRECTORY [--matching]",
    );
  return { browser, output, mode };
}

export const runCli = async (output, ...args) => {
  let stdout;
  try {
    ({ stdout } = await execute(process.execPath, [cli, ...args, "--json"], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    if (typeof error.stdout !== "string") throw error;
    const path = join(output, `failure-${args[0]}.json`);
    await writeFile(path, error.stdout, { flag: "wx" });
    await writeFile(
      join(output, `failure-${args[0]}.stderr.log`),
      error.stderr ?? "",
      { flag: "wx" },
    );
    throw new Error(
      `${args[0]} failed; complete diagnostics retained at ${path}`,
    );
  }
  const value = JSON.parse(stdout);
  if (value.error !== undefined || typeof value.code === "string") {
    const path = join(output, `failure-${args[0]}.json`);
    await writeFile(path, stdout, { flag: "wx" });
    throw new Error(
      `${args[0]} failed; complete diagnostics retained at ${path}`,
    );
  }
  return value;
};

async function main() {
  const { browser, output, mode } = exampleArguments();
  const run = (...args) => runCli(output, ...args);
  await mkdir(output); // Refuse to overwrite a previous investigation.
  const save = async (name, value) => {
    const path = join(output, name);
    await writeFile(path, JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
    });
    return path;
  };
  const original = await site(1);
  let candidate;
  await withVerifierCleanup(async () => {
    candidate = await site(mode === "--matching" ? 1 : 2);
    const originalRequest = await save(
      "original-scenario.json",
      scenario(browser, original.origin),
    );
    const candidateRequest = await save(
      "candidate-scenario.json",
      scenario(browser, candidate.origin),
    );
    const left = parseEvidence(
      await run("capture-browser-scenario", originalRequest),
    );
    const right = parseEvidence(
      await run("capture-browser-scenario", candidateRequest),
    );
    const leftPath = await save("original-evidence.json", left);
    const rightPath = await save("candidate-evidence.json", right);
    const mapping = {
      before_origin: original.origin,
      after_origin: candidate.origin,
    };
    const mappingPath = await save("origin-mapping.json", mapping);
    const capture = parseEvidence(
      await run(
        "compare-web-captures",
        leftPath,
        rightPath,
        "--origin-mapping-json",
        mappingPath,
      ),
    );
    const pixels = parseEvidence(
      await run(
        "compare-web-screenshots",
        leftPath,
        rightPath,
        "--step-id",
        "save",
        "--origin-mapping-json",
        mappingPath,
        "--channel-threshold",
        "0",
      ),
    );
    await save("capture-comparison.json", capture);
    await save("pixel-comparison.json", pixels);
    const request = {
      specification: specification(capture, pixels),
      evidence_bundle: createEvidenceBundle([left, right, capture, pixels]),
    };
    const verificationPath = await save("verification-request.json", request);
    const cliResult = await run("verify-reconstruction", verificationPath);
    await save("cli-verification.json", cliResult);

    const mcpVerification = await verifyMcp({
      left,
      right,
      mapping,
      capture,
      pixels,
      cliResult,
    });
    await save("mcp-verification.json", mcpVerification);
    const claims = cliResult.claims.items.map(({ claim_id, status }) => ({
      claim_id,
      status,
    }));
    assert.deepEqual(claims, [
      { claim_id: "save-appearance", status: "pass" },
      {
        claim_id: "save-count",
        status: mode === "--matching" ? "pass" : "fail",
      },
      { claim_id: "save-storage", status: "unknown" },
    ]);
    process.stdout.write(
      JSON.stringify({ output, status: cliResult.status, claims }, null, 2) +
        "\n",
    );
  }, [() => candidate?.close(), () => original.close()]);
}

export async function verifyMcp({
  left,
  right,
  mapping,
  capture,
  pixels,
  cliResult,
}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({
    name: "web-reconstruction-example",
    version: "1",
  });
  return await withVerifierCleanup(async () => {
    await client.connect(transport);
    const call = async (name, arguments_) => {
      const reply = await client.callTool({ name, arguments: arguments_ });
      if (reply.isError) throw new Error(JSON.stringify(reply));
      return parseEvidence(reply.structuredContent);
    };
    // Inline sources are retained with the comparison. The next call uses
    // exact same-session references rather than transferring PNGs again.
    const mcpCapture = await call("compare_web_captures", {
      left,
      right,
      origin_mapping: mapping,
    });
    const reference = (record) => ({
      kind: "retained-evidence",
      evidence_id: record.evidence_id,
    });
    const mcpPixels = await call("compare_web_screenshots", {
      left: reference(left),
      right: reference(right),
      step_id: "save",
      origin_mapping: mapping,
      channel_threshold: 0,
    });
    assert.equal(mcpCapture.evidence_id, capture.evidence_id);
    assert.equal(mcpPixels.evidence_id, pixels.evidence_id);
    const verified = await call("verify_reconstruction", {
      specification: specification(mcpCapture, mcpPixels),
    });
    assert.deepEqual(verified.normalized_result, cliResult);
    return verified;
  }, [() => client.close(), () => transport.close()]);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await main();
