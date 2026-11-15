#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEvidence } from "../../dist/domain/evidence.js";
import { createEvidenceBundle } from "../../dist/domain/evidenceBundle.js";
import {
  readWebComparisonSource,
  readWebScenarioSource,
} from "../../dist/domain/webComparisonSources.js";
import {
  runCli,
  scenario,
  site,
  specification,
  verifyMcp,
} from "./web-reconstruction.mjs";

import { withVerifierCleanup } from "../lib/verifier-cleanup.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(root, "scripts", "rea.mjs");

/** This fixture's deterministic builder reads the observed report, never the original source. */
export function webReconstructionBrief(input) {
  const evidence = readWebComparisonSource(parseEvidence(input));
  assert(
    evidence.authority === "controlled-replay" &&
      evidence.confidence === "observed",
    "The brief requires an observed controlled browser reference.",
  );
  const { capture } = readWebScenarioSource(evidence);
  const step = capture.steps.find((value) => value.step_id === "save");
  assert(
    step?.status === "completed" && capture.completeness.equality_eligible,
    "The original reference case must complete with qualifying coverage.",
  );
  const reports = capture.events.items.filter(
    (event) =>
      event.step_index === step.step_index &&
      event.kind === "console" &&
      /^saved-count=\d+$/u.test(event.text),
  );
  assert.equal(
    reports.length,
    1,
    "The fixture requires one unambiguous observed save-count report.",
  );
  assert(
    step.artifacts.screenshot.state === "captured",
    "A visual reference must have been captured.",
  );
  const report = reports[0];
  const count = report.text.slice("saved-count=".length);
  assert(
    Number.isSafeInteger(Number(count)),
    "The example builder requires an exact safe counter value.",
  );
  return {
    question:
      "How does Save report its result, and can an independent page reproduce that observed case?",
    scope:
      "The source-owned Save page, one click, one viewport. No third-party target or persistence claim.",
    original: {
      evidence_id: evidence.evidence_id,
      origin: capture.scenario.start_origin,
      scenario_sha256: evidence.parameters.scenario_sha256,
    },
    observed: {
      step_id: "save",
      event_sequence: report.sequence,
      saved_count: count,
      screenshot_sha256: step.artifacts.screenshot.value.sha256,
    },
    requirements: [
      {
        claim_id: "save-appearance",
        requirement:
          "The saved screen matches the captured pixels at channel threshold zero and changed ratio zero.",
        source_evidence_ids: [evidence.evidence_id],
      },
      {
        claim_id: "save-count",
        requirement: `Clicking Save reports saved-count=${count}. This report alone does not establish persistence.`,
        source_evidence_ids: [evidence.evidence_id],
      },
    ],
    implementation_choices: [
      "The independent example uses event delegation and a generated HTML file; these are builder choices, not recovered original implementation.",
    ],
    unknowns: ["Storage was not observed and must remain unknown."],
    stopping_criteria:
      "Required visual/report cases pass after correction; report the storage unknown separately.",
  };
}

/** An independent candidate implementation; the optional defect is deliberate example input. */
export function webCandidateFromBrief(brief, defect = false) {
  const count = Number(brief.observed.saved_count) + (defect ? 1 : 0);
  assert(
    Number.isSafeInteger(count),
    "The example counter is outside its supported range.",
  );
  return `<!doctype html><meta charset="utf-8"><title>Independent Save candidate</title>
<style>body{margin:0;background:#fff;color:#142030;font:16px Arial}main{padding:32px}button{font:inherit;padding:12px 24px}p{height:24px}</style>
<main><h1>Settings</h1><button id="save">Save</button><p id="status">Ready</p></main>
<script>document.addEventListener('click', event => { if (event.target.id !== 'save') return; document.getElementById('status').textContent = 'Saved'; console.info('saved-count=' + ${count}); });</script>`;
}

async function candidateSite(path) {
  const server = createServer(async (_request, response) => {
    try {
      const content = await readFile(path);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(content);
    } catch {
      response.writeHead(500);
      response.end("Candidate file unavailable");
    }
  });
  await new Promise((resolve_, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve_);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve_, reject) =>
        server.close((error) => (error ? reject(error) : resolve_())),
      ),
  };
}

async function saveRecipePrompt(output, browser, original) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({
    name: "web-reconstruction-recipe",
    version: "1",
  });
  await withVerifierCleanup(async () => {
    await client.connect(transport);
    const prompt = await client.getPrompt({
      name: "reconstruct_web_feature",
      arguments: {
        feature: "Reproduce the observed Save report and saved screen",
        original_url: `${original.origin}/`,
        browser_executable_path: browser,
        output_directory: output,
      },
    });
    assert(prompt.messages[0]?.content.type === "text");
    await writeFile(
      join(output, "recipe-prompt.md"),
      prompt.messages[0].content.text,
      { flag: "wx" },
    );
  }, [() => client.close(), () => transport.close()]);
}

async function compareRound(context, name) {
  const { browser, candidate, left, mappingPath, run, save } = context;
  const request = await save(
    `${name}-scenario.json`,
    scenario(browser, candidate.origin),
  );
  const right = parseEvidence(await run("capture-browser-scenario", request));
  const rightPath = await save(`${name}-evidence.json`, right);
  const capture = parseEvidence(
    await run(
      "compare-web-captures",
      context.leftPath,
      rightPath,
      "--origin-mapping-json",
      mappingPath,
    ),
  );
  const pixels = parseEvidence(
    await run(
      "compare-web-screenshots",
      context.leftPath,
      rightPath,
      "--step-id",
      "save",
      "--origin-mapping-json",
      mappingPath,
    ),
  );
  await save(`${name}-capture-comparison.json`, capture);
  await save(`${name}-pixel-comparison.json`, pixels);
  const verificationPath = await save(`${name}-verification-request.json`, {
    specification: specification(capture, pixels),
    evidence_bundle: createEvidenceBundle([left, right, capture, pixels]),
  });
  const verified = await run("verify-reconstruction", verificationPath);
  await save(`${name}-verification.json`, verified);
  const mcp = await verifyMcp({
    left,
    right,
    mapping: context.mapping,
    capture,
    pixels,
    cliResult: verified,
  });
  await save(`${name}-mcp-verification.json`, mcp);
  return { verified, right, capture, pixels };
}

async function saveHandoff({
  output,
  save,
  left,
  brief,
  candidatePath,
  firstBuild,
  correctedBuild,
  before,
  after,
}) {
  const allRecords = [
    left,
    before.right,
    before.capture,
    before.pixels,
    after.right,
    after.capture,
    after.pixels,
  ];
  const bundle = createEvidenceBundle(allRecords);
  await save("evidence-bundle.json", bundle);
  const handoff = {
    question: brief.question,
    outcome:
      "Required finite visual/report claims passed after correction; storage remains unknown.",
    before: before.verified.claims.items,
    after: after.verified.claims.items,
    candidate_path: candidatePath,
    implementation_artifacts: [
      {
        path: join(output, "candidate-before.html"),
        sha256: createHash("sha256").update(firstBuild).digest("hex"),
      },
      {
        path: candidatePath,
        sha256: createHash("sha256").update(correctedBuild).digest("hex"),
      },
    ],
    original_evidence_id: left.evidence_id,
    evidence_ids: bundle.records.map((record) => record.evidence_id),
    residual_unknowns: brief.unknowns,
    limitations: [
      "Source-owned deterministic example builder, not an AI coding agent or a general website reconstruction algorithm.",
      "No global implementation equivalence or persistence proof.",
    ],
  };
  await save("handoff.json", handoff);
  process.stdout.write(
    JSON.stringify(
      {
        output,
        before: before.verified.status,
        after: after.verified.status,
        required_claims_passed: after.verified.claims.items
          .filter((claim) => claim.claim_id !== "save-storage")
          .every((claim) => claim.status === "pass"),
        remaining_unknowns: brief.unknowns,
      },
      null,
      2,
    ) + "\n",
  );
}

async function main() {
  const [browser, output, ...extra] = process.argv.slice(2);
  assert(
    browser &&
      output &&
      isAbsolute(browser) &&
      isAbsolute(output) &&
      extra.length === 0,
    "Usage: node scripts/examples/web-reconstruction-recipe.mjs ABSOLUTE_BROWSER_PATH NEW_ABSOLUTE_OUTPUT_DIRECTORY",
  );
  await access(browser);
  await mkdir(output);
  const save = async (name, value) => {
    const path = join(output, name);
    await writeFile(path, JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
    });
    return path;
  };
  const run = (...args) => runCli(output, ...args);
  const original = await site(1);
  let candidate;
  await withVerifierCleanup(async () => {
    await saveRecipePrompt(output, browser, original);
    const originalRequest = await save(
      "original-scenario.json",
      scenario(browser, original.origin),
    );
    const left = parseEvidence(
      await run("capture-browser-scenario", originalRequest),
    );
    const leftPath = await save("original-evidence.json", left);
    const brief = webReconstructionBrief(left);
    await save("reconstruction-brief.json", brief);
    const candidatePath = join(output, "candidate.html");
    const firstBuild = webCandidateFromBrief(brief, true);
    await writeFile(candidatePath, firstBuild, { flag: "wx" });
    await writeFile(join(output, "candidate-before.html"), firstBuild, {
      flag: "wx",
    });
    candidate = await candidateSite(candidatePath);
    const mapping = {
      before_origin: original.origin,
      after_origin: candidate.origin,
    };
    const mappingPath = await save("origin-mapping.json", mapping);
    const context = {
      output,
      browser,
      original,
      candidate,
      left,
      leftPath,
      mapping,
      mappingPath,
      run,
      save,
    };
    const before = await compareRound(context, "before");
    assert.deepEqual(
      before.verified.claims.items.map(({ status }) => status),
      ["pass", "fail", "unknown"],
    );
    const correction = {
      reason:
        "The selected Save event reports a different count despite equal pixels.",
      failed_claim: "save-count",
      source_evidence_ids: [left.evidence_id, before.capture.evidence_id],
      implementation_change:
        "Use the observed report value instead of the deliberate off-by-one defect.",
    };
    await save("correction.json", correction);
    const correctedBuild = webCandidateFromBrief(brief);
    assert.notEqual(
      correctedBuild,
      firstBuild,
      "The correction must change candidate code.",
    );
    await writeFile(candidatePath, correctedBuild);
    const after = await compareRound(context, "after");
    assert.deepEqual(
      after.verified.claims.items.map(({ status }) => status),
      ["pass", "pass", "unknown"],
    );
    await saveHandoff({
      output,
      save,
      left,
      brief,
      candidatePath,
      firstBuild,
      correctedBuild,
      before,
      after,
    });
  }, [() => candidate?.close(), () => original.close()]);
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await main();
