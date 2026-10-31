#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { createAnalysisProfile } from "../dist/domain/analysisProfile.js";
import { createEvidenceBundle } from "../dist/domain/evidenceBundle.js";
import { inspectVerifierGhidraInstallation } from "./lib/ghidra-installation-inspection.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import {
  createVerifierMcpOwner,
  VerifierStdioTransport,
} from "./lib/verifier-mcp-owner.mjs";
import {
  requireMcpOutput,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";

const exec = promisify(execFile);
const installDir = process.env.GHIDRA_INSTALL_DIR;
if (installDir === undefined || !isAbsolute(installDir))
  throw new Error(
    "Set GHIDRA_INSTALL_DIR to an absolute Ghidra installation path.",
  );
const installation = await inspectVerifierGhidraInstallation({
  environment: process.env,
  installDir,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
if (installation.status !== "available")
  throw new Error(`Ghidra is unavailable: ${JSON.stringify(installation)}`);
if (process.platform === "win32")
  throw new Error("REA selected Ghidra projects are supported on POSIX hosts.");
const scriptRoot = fileURLToPath(
  new URL("../tests/conformance/ghidra/", import.meta.url),
);
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const workspace = await mkdtemp(join(tmpdir(), "rea-ghidra-project-coverage-"));
const connections = createVerifierMcpOwner();
const target = join(workspace, "fixture");
const projects = join(workspace, "projects");
const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  JAVA_HOME: installation.javaHome,
  GHIDRA_INSTALL_DIR: installation.installDir,
  REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact",
  REA_LOG_LEVEL: "silent",
};
const hash = (data) => createHash("sha256").update(data).digest("hex");
async function manifest(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory()
        ? manifest(path)
        : entry.isFile()
          ? [[path, hash(await readFile(path))]]
          : [];
    }),
  );
  return files.flat().sort((a, b) => a[0].localeCompare(b[0]));
}
async function connect(environment) {
  const client = new Client({
    name: "selected-project-coverage-verifier",
    version: "1",
  });
  const transport = new VerifierStdioTransport({
    command: process.execPath,
    args: [entrypoint, "mcp"],
    env: environment,
    stderr: "pipe",
  });
  return connections.open(client, transport);
}
async function call(connection, name, args = {}) {
  const reply = await connection.client.callTool(
    { name, arguments: args },
    { timeout: 180000, toolDefinition: connection.definitions.get(name) },
  );
  return requireMcpOutput(reply, name);
}
await withVerifierCleanup(async () => {
  await mkdir(projects);
  await exec(
    process.env.REA_CC ?? "cc",
    [
      "-O0",
      "-g",
      "-fno-inline",
      "-fno-optimize-sibling-calls",
      join(scriptRoot, "selected-project-coverage.c"),
      "-o",
      target,
    ],
    { env, timeout: 120000 },
  );
  for (const name of ["partial", "analyzed"]) {
    const args = [projects, name, "-import", target];
    if (name === "partial")
      args.push(
        "-noanalysis",
        "-scriptPath",
        scriptRoot,
        "-postScript",
        "ReaSelectedProjectSeeds.java",
      );
    const result = await exec(installation.analyzeHeadlessPath, args, {
      env,
      timeout: 180000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (name === "partial")
      for (const seed of [
        "rea_project_leaf",
        "rea_project_caller",
        "rea_project_other",
      ])
        assert.match(result.stdout, new RegExp(`REA_PROJECT_SEED ${seed} `));
  }
  const before = {
    target: hash(await readFile(target)),
    projects: await manifest(projects),
  };
  const report = [];
  for (const mode of ["fresh", "partial", "analyzed"]) {
    const selected = mode !== "fresh";
    const connection = await connect({
      ...env,
      ...(selected
        ? {
            REA_GHIDRA_PROJECT_PATH: join(projects, `${mode}.gpr`),
            REA_GHIDRA_PROGRAM_NAME: "fixture",
          }
        : {}),
    });
    const bundlePath = join(workspace, `${mode}.json`);
    const paths = [];
    await withVerifierCleanup(async () => {
      await call(connection, "open_binary", {
        path: target,
        provider_id: "ghidra",
      });
      const inventory = (
        await call(connection, "list_procedures", {
          detail: "complete",
        })
      ).normalized_result;
      const entry = (name) => {
        const matches = inventory.filter(
          (item) => item.value === name || item.value === `_${name}`,
        );
        assert.equal(matches.length, 1, `Expected one entry for ${name}`);
        return matches[0].address;
      };
      const leaf = entry("rea_project_leaf"),
        caller = entry("rea_project_caller"),
        other = entry("rea_project_other");
      const direct = await call(connection, "procedure_callees", {
        procedure: caller,
      });
      assert.equal(
        direct.relationship_coverage.status,
        selected ? "unknown" : "complete",
      );
      assert.equal(direct.normalized_result.includes(leaf), mode !== "partial");
      assert.equal(
        direct.analysis_profile.parameters
          .selected_project_relationship_coverage,
        selected ? "prior-analysis-unknown-v1" : undefined,
      );
      for (const [start, goal, direction] of [
        [caller, leaf, "forward"],
        [leaf, caller, "backward"],
        [other, caller, "backward"],
      ]) {
        const evidence = await call(connection, "trace_call_path", {
          start,
          goal,
          direction,
        });
        paths.push(evidence);
      }
      assert.equal(
        paths[0].normalized_result.goal_status,
        mode === "partial" ? "unknown" : "reached",
      );
      assert.equal(
        paths[1].normalized_result.goal_status,
        mode === "partial" ? "unknown" : "reached",
      );
      assert.equal(
        paths[2].normalized_result.goal_status,
        selected ? "unknown" : "not_reached",
      );
      if (selected)
        for (const evidence of paths)
          assert.ok(
            Object.values(
              evidence.normalized_result.relationship_coverage,
            ).some(
              (coverage) =>
                coverage.status === "unknown" &&
                /prior analysis completeness is unknown/u.test(coverage.reason),
            ),
          );
      if (mode === "analyzed") {
        const dossier = await call(connection, "analyze_function", {
          procedure: entry("rea_project_callback"),
          detail: "complete",
        });
        assert.equal(dossier.relationship_coverage.status, "unknown");
        assert.match(
          dossier.relationship_coverage.reason,
          /decoded call\(s\) without destinations/u,
        );
        assert.match(
          dossier.relationship_coverage.reason,
          /prior analysis completeness is unknown/u,
        );
        const callbackPath = await call(connection, "trace_call_path", {
          start: entry("rea_project_callback"),
          goal: leaf,
          direction: "forward",
        });
        const coverages = Object.values(
          callbackPath.normalized_result.relationship_coverage,
        );
        assert.ok(
          coverages.some(
            (coverage) =>
              coverage.status === "partial" &&
              coverage.limitations.some((text) =>
                /decoded call\(s\) without destinations/u.test(text),
              ) &&
              coverage.limitations.some((text) =>
                /prior analysis completeness is unknown/u.test(text),
              ),
          ),
        );
      }
      await call(connection, "export_evidence_bundle", { path: bundlePath });
      if (mode === "partial") {
        const snapshotPath = join(workspace, "partial-snapshot.json");
        await call(connection, "close_binary", { snapshot_path: snapshotPath });
        const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
        assert.equal(
          snapshot.binding.analysis_profile.parameters
            .selected_project_relationship_coverage,
          "prior-analysis-unknown-v1",
        );
        const profile = snapshot.binding.analysis_profile;
        const oldParameters = { ...profile.parameters };
        delete oldParameters.selected_project_relationship_coverage;
        const stalePath = join(workspace, "partial-old-profile.json");
        await writeFile(
          stalePath,
          JSON.stringify({
            ...snapshot,
            binding: {
              ...snapshot.binding,
              analysis_profile: createAnalysisProfile(
                profile.provider,
                oldParameters,
              ),
            },
            entries: [],
            workflow_entries: [],
            evidence_bundle: createEvidenceBundle([]),
          }),
        );
        const staleBefore = await readFile(stalePath);
        const refused = await connection.client.callTool({
          name: "open_binary",
          arguments: {
            path: target,
            provider_id: "ghidra",
            snapshot_path: stalePath,
          },
        });
        const error = requireMcpToolError(refused);
        assert.equal(error.code, "evidence_integrity_mismatch");
        assert.match(error.details.reason, /profile_mismatch/u);
        assert.deepEqual(await readFile(stalePath), staleBefore);
        await call(connection, "open_binary", {
          path: target,
          provider_id: "ghidra",
          snapshot_path: snapshotPath,
        });
        const replay = await call(connection, "trace_call_path", {
          start: caller,
          goal: leaf,
          direction: "forward",
        });
        assert.deepEqual(replay.normalized_result, paths[0].normalized_result);
        await call(connection, "close_binary");
      } else await call(connection, "close_binary");
    }, [() => connections.closeConnection(connection)]);
    const offline = await connect(env);
    await withVerifierCleanup(async () => {
      await call(offline, "import_evidence_bundle", { path: bundlePath });
      const records = (
        await call(offline, "get_evidence_bundle", { detail: "complete" })
      ).result.records;
      for (const evidence of paths) {
        const saved = records.find(
          (record) => record.evidence_id === evidence.evidence_id,
        );
        assert.ok(saved);
        assert.deepEqual(saved.normalized_result, evidence.normalized_result);
        assert.deepEqual(saved.limitations, evidence.limitations);
      }
    }, [() => connections.closeConnection(offline)]);
    report.push({
      mode,
      statuses: paths.map((evidence) => evidence.normalized_result.goal_status),
    });
  }
  assert.deepEqual(
    {
      target: hash(await readFile(target)),
      projects: await manifest(projects),
    },
    before,
  );
  process.stdout.write(
    `${JSON.stringify({ ok: true, provider: installation.providerVersion, results: report })}\n`,
  );
}, [
  async () => {
    await connections.close();
    await rm(workspace, { recursive: true, force: true });
  },
]);
