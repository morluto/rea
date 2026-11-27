#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../dist/process/OwnedCommand.js";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";
import { Client } from "@modelcontextprotocol/client";
import { createAnalysisProfile } from "../dist/domain/analysisProfile.js";
import { createEvidenceBundle } from "../dist/domain/evidenceBundle.js";
import { inspectVerifierGhidraFromEnvironment } from "./lib/ghidra-installation-inspection.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import {
  VerifierFixture,
  withVerifierFixture,
} from "./lib/verifier-fixture.mjs";
import {
  createVerifierMcpOwner,
  VerifierStdioTransport,
} from "./lib/verifier-mcp-owner.mjs";
import {
  requireMcpOutput,
  requireMcpToolError,
} from "./lib/mcp-verifier-results.mjs";
import { completeEvidenceClient } from "./lib/complete-evidence.mjs";

export async function verifyProjectCoverage(run) {
  const installDir = process.env.GHIDRA_INSTALL_DIR;
  if (installDir === undefined || !isAbsolute(installDir))
    throw new Error(
      "Set GHIDRA_INSTALL_DIR to an absolute Ghidra installation path.",
    );
  const installation = await inspectVerifierGhidraFromEnvironment(
    process.env,
    installDir,
  );
  if (installation.status !== "available")
    throw new Error(`Ghidra is unavailable: ${JSON.stringify(installation)}`);
  if (process.platform === "win32")
    throw new Error(
      "REA selected Ghidra projects are supported on POSIX hosts.",
    );
  const scriptRoot = fileURLToPath(
    new URL("../tests/conformance/ghidra/", import.meta.url),
  );
  const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
  const fixture = await VerifierFixture.open({
    prefix: "rea-ghidra-project-coverage-",
    private: false,
  });
  const workspace = fixture.path;
  const connections = createVerifierMcpOwner();
  // The workspace is removed only after every MCP connection confirms.
  fixture.releaseAfter(() => connections.close());
  const target = join(workspace, "fixture");
  const projects = join(workspace, "projects");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    JAVA_HOME: installation.javaHome,
    GHIDRA_INSTALL_DIR: installation.installDir,
    REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact",
    REA_LOG_LEVEL: "silent",
    REA_PROCESS_RUN_ID: run.run_id,
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
    const client = completeEvidenceClient(
      new Client({
        name: "selected-project-coverage-verifier",
        version: "1",
      }),
    );
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
  const command = async (executable, args, timeoutMs) => {
    try {
      return await runOwnedCommand(
        {
          command: executable,
          arguments: args,
          env,
          runId: run.run_id,
          expectedCommand: null,
        },
        { timeoutMs, diagnosticBytes: 16 * 1024 * 1024 },
      );
    } catch (cause) {
      // A command whose process group was not confirmed stopped may still
      // use the workspace, so the fixture keeps it.
      if (
        cause instanceof OwnedCommandFailure &&
        cause.cleanupOwner !== undefined
      )
        fixture.retain(
          `${executable} cleanup is incomplete; it may still use ${workspace}`,
        );
      throw cause;
    }
  };
  return await withVerifierFixture(fixture, async () => {
    await mkdir(projects);
    // REA_CC is the invoking developer's explicitly selected compiler, not target input.
    await command(
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
      120000,
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
      const result = await command(
        installation.analyzeHeadlessPath,
        args,
        180000,
      );
      if (name === "partial")
        for (const seed of [
          "rea_project_leaf",
          "rea_project_caller",
          "rea_project_other",
        ])
          assert.match(
            result.stdout.text,
            new RegExp(`REA_PROJECT_SEED ${seed} `),
          );
    }
    const before = {
      target: hash(await readFile(target)),
      projects: await manifest(projects),
    };
    const report = [];
    const selectionFromStatus = (status) => ({
      selection_source: status.analysis_provider_binding.selection_source,
      candidates: status.analysis_provider_candidates.map((candidate) => ({
        provider: candidate.provider,
        selected: candidate.selected,
        availability: candidate.availability.status,
        target_support: candidate.target_support.status,
        rejection_codes: [
          ...new Set(candidate.rejections.map(({ code }) => code)),
        ],
      })),
    });
    // GhidraProjectHistory preserves saved Program reports, not this run's work.
    const isProjectHistory = (evidence) =>
      evidence.provider.id === "ghidra" &&
      evidence.operation === "health" &&
      evidence.parameters.facet === "historical-project-analysis-reports" &&
      evidence.normalized_result?.origin === "caller-project";
    const assertSelection = (evidence, selection) => {
      const selected = selection.candidates.find(
        (candidate) => candidate.selected,
      );
      assert.ok(selected);
      if (isProjectHistory(evidence))
        assert.equal(
          evidence.provider_selection,
          undefined,
          `${evidence.operation} ${evidence.evidence_id} must preserve historical provenance absence`,
        );
      else if (evidence.provider.id === selected.provider.id)
        assert.deepEqual(
          evidence.provider_selection,
          selection,
          `${evidence.operation} ${evidence.evidence_id} must retain its native provider selection`,
        );
      else {
        assert.equal(evidence.provider_selection, undefined);
        assert.ok(
          evidence.evidence_links.length > 0,
          "Derived output must cite its native sources",
        );
      }
      assert.match(evidence.evidence_id, /^ev_[a-f0-9]{64}$/u);
    };
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
        const status = (
          await call(connection, "binary_session", { detail: "complete" })
        ).result;
        const selection = selectionFromStatus(status);
        assert.equal(selection.selection_source, "request");
        const observed = [];
        const inventoryEvidence = await call(connection, "list_procedures", {
          detail: "complete",
        });
        assertSelection(inventoryEvidence, selection);
        const inventory = inventoryEvidence.normalized_result;
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
        assertSelection(direct, selection);
        assert.equal(
          direct.relationship_coverage.status,
          selected ? "unknown" : "complete",
        );
        assert.equal(
          direct.normalized_result.includes(leaf),
          mode !== "partial",
        );
        assert.equal(
          direct.analysis_profile.parameters
            .selected_project_relationship_coverage,
          selected ? "prior-analysis-unknown" : undefined,
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
          assertSelection(evidence, selection);
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
        assert.equal(paths[2].normalized_result.goal_status, "unknown");
        if (!selected) {
          assert.equal(
            paths[2].normalized_result.search_scope.observed_goal_status,
            "not_reached",
          );
          assert.equal(
            paths[2].normalized_result.search_scope.discovery,
            "unknown",
          );
        }
        if (selected)
          for (const evidence of paths)
            assert.ok(
              Object.values(
                evidence.normalized_result.relationship_coverage,
              ).some(
                (coverage) =>
                  coverage.status === "unknown" &&
                  /prior analysis completeness is unknown/u.test(
                    coverage.reason,
                  ),
              ),
            );
        if (mode === "analyzed") {
          const dossier = await call(connection, "analyze_function", {
            procedure: entry("rea_project_callback"),
            detail: "complete",
          });
          assertSelection(dossier, selection);
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
          assertSelection(callbackPath, selection);
          observed.push(dossier, callbackPath);
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
        const exported = JSON.parse(await readFile(bundlePath, "utf8"));
        observed.push(inventoryEvidence, direct, ...paths);
        const exportedById = new Map(
          exported.records.map((record) => [record.evidence_id, record]),
        );
        for (const native of exported.records.filter(
          (record) => record.provider.id === "ghidra",
        ))
          assertSelection(native, selection);
        assert.ok(
          exported.records.some(
            (record) =>
              record.provider.id === "ghidra" && !isProjectHistory(record),
          ),
          "Expected a fresh native observation",
        );
        const reachesNativeSource = (evidence) => {
          const pending = [...evidence.evidence_links];
          const seen = new Set();
          while (pending.length > 0) {
            const id = pending.pop();
            if (seen.has(id)) continue;
            seen.add(id);
            const source = exportedById.get(id);
            if (source === undefined) continue;
            if (source.provider.id === "ghidra" && !isProjectHistory(source))
              return true;
            pending.push(...source.evidence_links);
          }
          return false;
        };
        for (const evidence of observed) {
          if (evidence.provider.id !== "ghidra")
            assert.ok(
              reachesNativeSource(evidence),
              "Derived output must reach an exported native source",
            );
          const saved = exported.records.find(
            (record) => record.evidence_id === evidence.evidence_id,
          );
          assert.ok(saved);
          assertSelection(saved, selection);
          assert.deepEqual(
            saved.provider_selection,
            evidence.provider_selection,
          );
        }
        if (mode === "partial") {
          const snapshotPath = join(workspace, "partial-snapshot.json");
          await call(connection, "close_binary", {
            snapshot_path: snapshotPath,
          });
          const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
          assert.equal(
            snapshot.binding.analysis_profile.parameters
              .selected_project_relationship_coverage,
            "prior-analysis-unknown",
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
          assert.deepEqual(error.details.binding_mismatch.profile_digest, {
            snapshot: createAnalysisProfile(profile.provider, oldParameters)
              .digest,
            selected: profile.digest,
          });
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
          assertSelection(replay, selection);
          assert.deepEqual(
            replay.normalized_result,
            paths[0].normalized_result,
          );
          await call(connection, "close_binary");
        } else await call(connection, "close_binary");
      }, [() => connections.closeConnection(connection)]);
      const exportedNative = JSON.parse(
        await readFile(bundlePath, "utf8"),
      ).records.filter((record) => record.provider.id === "ghidra");
      assert.ok(exportedNative.length > 0);
      const offline = await connect(env);
      await withVerifierCleanup(async () => {
        await call(offline, "import_evidence_bundle", { path: bundlePath });
        const records = (
          await call(offline, "get_evidence_bundle", { detail: "complete" })
        ).result.records;
        for (const evidence of [...paths, ...exportedNative]) {
          const saved = records.find(
            (record) => record.evidence_id === evidence.evidence_id,
          );
          assert.ok(saved);
          assert.deepEqual(saved.normalized_result, evidence.normalized_result);
          assert.deepEqual(saved.limitations, evidence.limitations);
          assert.deepEqual(
            saved.provider_selection,
            evidence.provider_selection,
          );
        }
      }, [() => connections.closeConnection(offline)]);
      if (mode === "fresh") {
        const activeImport = await connect({
          ...env,
          REA_ANALYSIS_PROVIDER: "ghidra",
        });
        await withVerifierCleanup(async () => {
          await call(activeImport, "open_binary", { path: target });
          const status = (
            await call(activeImport, "binary_session", { detail: "complete" })
          ).result;
          const selection = selectionFromStatus(status);
          assert.equal(selection.selection_source, "environment");
          assert.notEqual(
            selection.selection_source,
            exportedNative.find((record) => !isProjectHistory(record))
              .provider_selection.selection_source,
          );
          await call(activeImport, "import_evidence_bundle", {
            path: bundlePath,
          });
          const own = await call(activeImport, "list_strings", {
            detail: "complete",
          });
          assertSelection(own, selection);
          const records = (
            await call(activeImport, "get_evidence_bundle", {
              detail: "complete",
            })
          ).result.records;
          for (const source of exportedNative) {
            const imported = records.find(
              (record) => record.evidence_id === source.evidence_id,
            );
            assert.ok(imported);
            assert.deepEqual(
              imported.provider_selection,
              source.provider_selection,
            );
            assert.deepEqual(
              imported.normalized_result,
              source.normalized_result,
            );
          }
          const legacy = {
            ...exportedNative.find(
              (record) => record.evidence_links.length === 0,
            ),
          };
          assert.ok(
            legacy.evidence_id,
            "Expected a complete native source without dependencies",
          );
          delete legacy.provider_selection;
          const legacyPath = join(workspace, "legacy-selection-absent.json");
          await writeFile(
            legacyPath,
            JSON.stringify(createEvidenceBundle([legacy])),
          );
          await call(activeImport, "import_evidence_bundle", {
            path: legacyPath,
          });
          const importedLegacy = (
            await call(activeImport, "get_evidence_bundle", {
              detail: "complete",
            })
          ).result.records.find(
            (record) => record.evidence_id === legacy.evidence_id,
          );
          assert.ok(importedLegacy);
          assert.equal(importedLegacy.provider_selection, undefined);
          assert.equal(importedLegacy.evidence_id, legacy.evidence_id);
          await call(activeImport, "close_binary");
        }, [() => connections.closeConnection(activeImport)]);
      }
      report.push({
        mode,
        statuses: paths.map(
          (evidence) => evidence.normalized_result.goal_status,
        ),
      });
    }
    assert.deepEqual(
      {
        target: hash(await readFile(target)),
        projects: await manifest(projects),
      },
      before,
    );
    return {
      ok: true,
      provider: installation.providerVersion,
      results: report,
    };
  });
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const run = createVerifierRun();
  const report = await verifyProjectCoverage(run);
  await completeVerifierRun(run);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
