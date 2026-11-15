#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEvidence } from "../../dist/domain/evidence.js";
import { createEvidenceBundle } from "../../dist/domain/evidenceBundle.js";
import {
  comparableProcessObservationPayload,
  projectProcessObservation,
} from "../../dist/domain/process/processObservation.js";
import { probeProcessCaptureCapability } from "../../dist/process/capture/ProcessCaptureCapability.js";

import { withVerifierCleanup } from "../lib/verifier-cleanup.mjs";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(root, "scripts", "rea.mjs");
const fixtures = join(root, "scripts", "examples", "fixtures");
const cases = [
  { id: "valid", arguments: ["sum", "2", "5"] },
  { id: "invalid", arguments: ["sum", "2", "nope"] },
];

// The finite policy compares all observed terminal/lifecycle payloads and
// multiplicities. Scheduling fields and event order are outside this brief.
function tracePolicy(capture, sources) {
  const events = new Map();
  const ignored = ["sequence", "at_ms", "elapsed_ms"];
  for (const location of capture.event_journal) {
    const observation = projectProcessObservation(capture, location);
    if (!observation || !sources.includes(observation.source)) continue;
    const exact = comparableProcessObservationPayload(
      observation.payload,
      ignored,
    );
    const key = JSON.stringify([observation.source, exact]);
    const previous = events.get(key);
    if (previous) previous.cardinality.count += 1;
    else
      events.set(key, {
        id: `event-${events.size}`,
        source: observation.source,
        exact,
        ignore_fields: ignored,
        cardinality: { kind: "exact", count: 1 },
      });
  }
  return {
    events: [...events.values()],
    language: {
      kind: "partial_order",
      happens_before: [],
      not_before: [],
      unordered_groups:
        events.size > 1
          ? [{ events: [...events.values()].map(({ id }) => id) }]
          : [],
      prefix: [],
      suffix: [],
    },
  };
}

const specification = (comparisons) => ({
  name: "Reconstruct the two declared sum invocations",
  claims: [
    ...comparisons.flatMap(({ id, evidence, exitEvidence }) =>
      ["terminal", "exit"].map((dimension) => ({
        claim_id: `${id}-${dimension}`,
        title: `${id}: identical observed ${dimension} payloads under the declared trace policy`,
        kind: "behavioral",
        dimension,
        comparison_evidence_id: (dimension === "exit" ? exitEvidence : evidence)
          .evidence_id,
      })),
    ),
    {
      claim_id: "valid-filesystem",
      title: "Filesystem equivalence remains unresolved without selected paths",
      kind: "behavioral",
      dimension: "filesystem",
      comparison_evidence_id: comparisons[0].evidence.evidence_id,
    },
  ],
});

// oxlint-disable-next-line max-lines-per-function -- keep this finite, ordered investigation inspectable as a complete example.
async function main() {
  const [output, extra] = process.argv.slice(2);
  if (!output || !isAbsolute(output) || extra !== undefined)
    throw new Error(
      "Usage: node scripts/examples/cli-reconstruction.mjs NEW_ABSOLUTE_OUTPUT_DIRECTORY",
    );
  const capability = await probeProcessCaptureCapability();
  if (!capability.available)
    throw new Error(
      `CLI recipe cannot capture processes: ${capability.reason}`,
    );
  await mkdir(output); // Refuse to overwrite an investigation, before launching targets.
  const save = async (name, value) => {
    const path = join(output, name);
    await writeFile(path, JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
    });
    return path;
  };
  const run = async (...args) => {
    try {
      const { stdout } = await execute(
        process.execPath,
        [cli, ...args, "--json"],
        {
          cwd: root,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
        },
      );
      const value = JSON.parse(stdout);
      if (value.error !== undefined || typeof value.code === "string")
        throw new Error(stdout);
      return value;
    } catch (cause) {
      const path = await save(`failure-${args[0]}-${Date.now()}.json`, {
        command: args,
        stdout: cause.stdout ?? cause.message,
        stderr: cause.stderr ?? "",
      });
      throw new Error(`${args[0]} failed; diagnostics retained at ${path}`, {
        cause,
      });
    }
  };
  const workspace = join(output, "working-directory");
  await mkdir(workspace);
  await save("scope.json", {
    question:
      "Can an independent CLI reproduce the original's two declared sum invocations?",
    owner: "source-owned fixture shipped with this example",
    inputs: cases,
    criteria: [
      "terminal payloads and counts",
      "exit and settlement state",
      "filesystem explicitly unknown",
    ],
    excluded: [
      "other inputs",
      "event timing and order",
      "network",
      "complete process tree",
      "global equivalence",
    ],
    builder:
      "Deterministic source-owned example implementer; no model is called by REA.",
  });
  const artifact = async (revision) => {
    const directory = join(output, revision);
    await mkdir(directory);
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: `recipe-${revision}`,
        version: "1.0.0",
        type: "module",
        bin: "app.mjs",
      }),
      { flag: "wx" },
    );
    const path = join(directory, "app.mjs");
    let build;
    if (revision === "original")
      await copyFile(join(fixtures, "cli-sum-original.mjs"), path);
    else {
      const { stdout } = await execute(
        process.execPath,
        [
          join(fixtures, "cli-sum-builder.mjs"),
          path,
          revision,
          join(output, "reconstruction-brief.json"),
        ],
        { windowsHide: true },
      );
      build = JSON.parse(stdout);
      await save(`${revision}-build.json`, build);
    }
    const bytes = await readFile(path);
    const analysis = parseEvidence(
      await run(
        "analyze-javascript-application",
        directory,
        "--artifact-format",
        "directory",
      ),
    );
    await save(`${revision}-static-evidence.json`, analysis);
    return {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      analysis,
      build,
    };
  };
  const capture = async (revision, target, testCase) => {
    const scenario = {
      executable: process.execPath,
      arguments: [target.path, ...testCase.arguments],
      working_directory: workspace,
      environment: { LANG: "C", LC_ALL: "C", NO_COLOR: "1" },
      filesystem_observation_paths: [],
      terminal: { columns: 80, rows: 8, scrollback: 0 },
      events: [],
      timeout_ms: 5_000,
      idle_timeout_ms: 5_000,
      settle_ms: 50,
      normalization: {
        paths: false,
        pids: true,
        ports: false,
        time_bucket_ms: 10,
        patterns: [],
      },
    };
    const requestPath = await save(
      `${revision}-${testCase.id}-scenario.json`,
      scenario,
    );
    const evidence = parseEvidence(await run("capture-process", requestPath));
    const path = await save(
      `${revision}-${testCase.id}-capture.json`,
      evidence,
    );
    return { ...testCase, path, evidence };
  };
  const original = await artifact("original");
  const references = [];
  for (const testCase of cases) {
    const source = await capture("original", original, testCase);
    const trace = tracePolicy(source.evidence.normalized_result, [
      "terminal_raw",
      "terminal_rendered",
    ]);
    const exitTrace = tracePolicy(source.evidence.normalized_result, [
      "lifecycle",
    ]);
    references.push({
      ...source,
      tracePath: await save(`${testCase.id}-trace-policy.json`, trace),
      exitTracePath: await save(
        `${testCase.id}-exit-trace-policy.json`,
        exitTrace,
      ),
    });
  }
  await save("reconstruction-brief.json", {
    question:
      "Implement only the two declared invocations; return terminal output and exit status matching the retained observations.",
    facts: references.map(({ id, arguments: args, evidence }) => ({
      id,
      arguments: args,
      evidence_id: evidence.evidence_id,
      observed_pty_output: evidence.normalized_result.frames
        .map(({ data }) => data)
        .join(""),
      observed_exit: evidence.normalized_result.exit,
    })),
    artifact: {
      script: original.path,
      sha256: original.sha256,
      static_evidence_id: original.analysis.evidence_id,
    },
    provenance_limit:
      "Capture executable digests identify Node. The explicit script argument, separate script SHA-256 and static Evidence associate this experiment with its selected artifact; they do not establish an automatic causal trace from source to runtime.",
    unknowns: [
      "No filesystem paths selected",
      "Inherited environment not recorded",
      "Network unobserved",
      "Unlisted inputs untested",
    ],
    trace_policy:
      "Ignore only top-level sequence, at_ms and elapsed_ms; compare terminal/lifecycle contents and counts, without claiming timing or order equivalence.",
  });
  await retainRecipePrompt(output, original.path, workspace);

  const retained = [
    original.analysis,
    ...references.map(({ evidence }) => evidence),
  ];
  const rounds = [];
  for (const revision of ["initial", "corrected"]) {
    const target = await artifact(revision);
    retained.push(target.analysis);
    const comparisons = [];
    for (const source of references) {
      const candidate = await capture(revision, target, source);
      const evidence = parseEvidence(
        await run(
          "compare-process-captures",
          source.path,
          candidate.path,
          source.tracePath,
        ),
      );
      await save(`${revision}-${source.id}-comparison.json`, evidence);
      const exitEvidence = parseEvidence(
        await run(
          "compare-process-captures",
          source.path,
          candidate.path,
          source.exitTracePath,
        ),
      );
      await save(`${revision}-${source.id}-exit-comparison.json`, exitEvidence);
      retained.push(candidate.evidence, evidence, exitEvidence);
      comparisons.push({ id: source.id, evidence, exitEvidence });
    }
    const bundle = createEvidenceBundle(retained);
    const bundlePath = await save(`${revision}-bundle.json`, bundle);
    const spec = specification(comparisons);
    const requestPath = await save(`${revision}-verification-request.json`, {
      specification: spec,
      evidence_bundle: bundle,
    });
    const result = await run("verify-reconstruction", requestPath);
    await save(`${revision}-cli-verification.json`, result);
    // A fresh MCP session imports exactly the same portable investigation.
    // Comparing again in that session would also create session-owned unknown
    // histories; importing preserves this bundle's precise verification scope.
    const mcp = await verifyMcp(bundlePath, spec);
    assert.deepEqual(mcp.normalized_result, result);
    await save(`${revision}-mcp-verification.json`, mcp);
    const claims = result.claims.items.map(({ claim_id, status }) => ({
      claim_id,
      status,
    }));
    const expected = revision === "initial" ? "fail" : "pass";
    assert.equal(
      claims.find(({ claim_id }) => claim_id === "valid-terminal")?.status,
      expected,
    );
    for (const claim of claims.filter(
      ({ claim_id }) =>
        claim_id !== "valid-terminal" && claim_id !== "valid-filesystem",
    ))
      assert.equal(claim.status, "pass");
    assert.equal(
      claims.find(({ claim_id }) => claim_id === "valid-filesystem")?.status,
      "unknown",
    );
    if (revision === "initial")
      assert.equal(
        comparisons[0].evidence.normalized_result.first_divergence.status,
        "found",
      );
    if (revision === "initial")
      await save("correction.json", {
        failed_claims: result.claims.items
          .filter(({ status }) => status === "fail")
          .map(
            ({
              claim_id,
              comparison_evidence_id,
              left_evidence_ids,
              right_evidence_ids,
            }) => ({
              claim_id,
              comparison_evidence_id,
              left_evidence_ids,
              right_evidence_ids,
            }),
          ),
        first_divergence:
          comparisons[0].evidence.normalized_result.first_divergence,
        candidate_before: {
          path: target.path,
          sha256: target.sha256,
          static_evidence_id: target.analysis.evidence_id,
        },
        brief_sha256: target.build.brief_sha256,
        change: {
          inferred_cause:
            "The first builder revision adds one beyond the offset derived from the observed valid case.",
          from_accumulator_offset: target.build.implemented_offset,
          to_accumulator_offset: target.build.derived_offset,
          next_candidate_path: join(output, "corrected", "app.mjs"),
        },
        recheck:
          "Repeat the same two declared inputs and unchanged acceptance policies.",
      });
    rounds.push({
      revision,
      script: target.path,
      script_sha256: target.sha256,
      status: result.status,
      claims,
      divergences: comparisons.map(({ id, evidence }) => ({
        id,
        comparison_evidence_id: evidence.evidence_id,
        first_divergence: evidence.normalized_result.first_divergence,
      })),
    });
  }
  const summary = {
    output,
    capture_provider: "real native PTY",
    platform: process.platform,
    original_script_sha256: original.sha256,
    rounds,
    mcp_cli_parity: true,
    conclusion:
      "The corrected candidate passes the four declared terminal/exit claims. Filesystem remains unknown; no global equivalence is asserted.",
  };
  await save("recipe-summary.json", summary);
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}

async function retainRecipePrompt(output, originalPath, workspace) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({
    name: "cli-reconstruction-recipe-guidance",
    version: "1",
  });
  return await withVerifierCleanup(async () => {
    await client.connect(transport);
    const prompt = await client.getPrompt({
      name: "reconstruct_cli_feature",
      arguments: {
        feature:
          "Reconstruct the two declared sum invocations with terminal/exit criteria and filesystem unknown",
        target_path: originalPath,
        working_directory: workspace,
        output_directory: output,
        arguments_json: JSON.stringify(cases[0].arguments),
        constraints:
          "Source-owned local fixture; only the two inputs in scope.json; independent implementation; no network or filesystem equivalence claim",
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

async function verifyMcp(bundlePath, specification_) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({
    name: "cli-reconstruction-recipe",
    version: "1",
  });
  return await withVerifierCleanup(async () => {
    await client.connect(transport);
    const imported = await client.callTool({
      name: "import_evidence_bundle",
      arguments: { path: bundlePath },
    });
    if (imported.isError) throw new Error(JSON.stringify(imported));
    const response = await client.callTool({
      name: "verify_reconstruction",
      arguments: { specification: specification_ },
    });
    if (response.isError) throw new Error(JSON.stringify(response));
    return parseEvidence(response.structuredContent);
  }, [() => client.close(), () => transport.close()]);
}

await main();
