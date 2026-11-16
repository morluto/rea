import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, onTestFinished } from "vitest";

import { parseConfig } from "../../../src/config/parseConfig.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { parseAnalysisSnapshot } from "../../../src/domain/analysisSnapshot.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { evidenceBundleSchema } from "../../../src/domain/evidenceBundle.js";
import { ok } from "../../../src/domain/result.js";
import { hopperProducerIdentity } from "../../../src/hopper/HopperBridgeSources.js";
import { HopperProvider } from "../../../src/hopper/HopperProvider.js";
import { silentLogger } from "../../../src/logger.js";
import {
  createAnalysisExecution,
  type AnalysisProvider,
} from "../../../src/ports/AnalysisProvider.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const query = {
  name: "address_name",
  arguments: { document: "selected", address: "0x1000" },
};

const fixture = async (existingRoot?: string) => {
  const root =
    existingRoot ?? (await createTestTempDirectory("rea-hopper-producer-mcp-"));
  const path = join(root, "selected.hop");
  const snapshotPath = join(root, "snapshot.json");
  const launcher = join(root, "hopper");
  if (existingRoot === undefined) {
    await writeFile(path, "owned database fixture");
    await writeFile(launcher, "owned launcher fixture");
  }
  const config = parseConfig({ HOPPER_LAUNCHER_PATH: launcher });
  if (!config.ok) throw config.error;
  const hopper = new HopperProvider(config.value, silentLogger, {}, "linux");
  onTestFinished(async () => {
    const closed = await hopper.closeOwnedResources();
    if (!closed.ok) throw closed.error;
  });
  let starts = 0;
  let reads = 0;
  // Real Hopper profile/capability owners, session, snapshot files and MCP
  // delivery. Execution replies are injected at AnalysisClient; no native
  // Hopper process or bridge is exercised.
  const provider: AnalysisProvider = {
    identity: () => hopper.identity(),
    capabilities: () => hopper.capabilities(),
    resolveAnalysisProfile: (...args) => hopper.resolveAnalysisProfile(...args),
    createClient: (_target, profile) => {
      if (profile === undefined) throw new Error("Expected Hopper profile");
      starts += 1;
      return {
        execute: async (operation) => {
          if (operation !== "health" && operation !== "address_name")
            throw new Error(`Unexpected engine operation: ${operation}`);
          if (operation === "address_name") reads += 1;
          return ok(
            createAnalysisExecution(
              operation === "health" ? {} : "observed_name",
              profile.provider,
              { analysisProfile: profile },
            ),
          );
        },
        close: async () => ok(null),
      };
    },
  };
  const harness = await createApplicationMcpHarness({
    session: createTestBinarySession(provider),
    serverOptions: { logger: silentLogger },
  });
  const call: typeof harness.client.callTool = async (...args) => {
    const result = await harness.client.callTool(...args);
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result;
  };
  const open = (selectedSnapshot?: string) =>
    call({
      name: "open_binary",
      arguments: {
        path,
        ...(selectedSnapshot === undefined
          ? {}
          : { snapshot_path: selectedSnapshot }),
      },
    });
  const save = (destination = snapshotPath) =>
    call({ name: "close_binary", arguments: { snapshot_path: destination } });
  return {
    ...harness,
    call,
    root,
    path,
    open,
    save,
    snapshotPath,
    freshSnapshotPath: join(root, "fresh.json"),
    starts: () => starts,
    reads: () => reads,
  };
};

it.each(["legacy marker", "earlier REA release", "edited bridge"] as const)(
  "refuses a Hopper snapshot from %s before engine creation and recovers without rewriting it",
  async (change) => {
    const f = await fixture();
    await f.open();
    await f.save();
    const saved = parseAnalysisSnapshot(
      JSON.parse(await readFile(f.snapshotPath, "utf8")),
    );
    const profile = saved.binding.analysis_profile;
    const { producer: _producer, ...parameters } = profile.parameters;
    const prior = createAnalysisProfile(profile.provider, {
      ...parameters,
      ...(change === "legacy marker"
        ? {
            function_dossier_coverage:
              "observed-facets-and-call-relationships-v1",
          }
        : {
            producer: {
              ...hopperProducerIdentity(),
              ...(change === "earlier REA release"
                ? { rea_version: "0.0.0-earlier" }
                : { sources_sha256: "0".repeat(64) }),
            },
          }),
    });
    const historical = parseAnalysisSnapshot({
      ...saved,
      binding: { provider: prior.provider, analysis_profile: prior },
    });
    await writeFile(f.snapshotPath, JSON.stringify(historical));
    const original = await readFile(f.snapshotPath, "utf8");
    const refused = parseMcpToolError(
      await f.client.callTool({
        name: "open_binary",
        arguments: { path: f.path, snapshot_path: f.snapshotPath },
      }),
    );
    expect(refused.error).toMatchObject({
      code: "evidence_integrity_mismatch",
      details: {
        binding_mismatch: {
          profile_digest: { snapshot: prior.digest, selected: profile.digest },
        },
      },
    });
    expect(f.starts()).toBe(0);
    expect(await readFile(f.snapshotPath, "utf8")).toBe(original);

    await f.open();
    const observed = parseEvidence((await f.call(query)).structuredContent);
    expect(observed.analysis_profile).toEqual(profile);
    const target = f.session.activeTarget();
    if (target === undefined) throw new Error("Expected recovered target");
    const observation = {
      operation: observed.operation,
      parameters: observed.parameters,
      result: observed.normalized_result,
      rawResult: observed.raw_result,
      limitations: observed.limitations,
      locations: observed.locations,
    };
    expect(
      createEvidence(target, observed.provider, {
        ...observation,
        analysisProfile: profile,
      }).evidence_id,
    ).toBe(observed.evidence_id);
    expect(
      createEvidence(target, observed.provider, {
        ...observation,
        analysisProfile: prior,
      }).evidence_id,
    ).not.toBe(observed.evidence_id);
    await f.save(f.freshSnapshotPath);
    const fresh = parseAnalysisSnapshot(
      JSON.parse(await readFile(f.freshSnapshotPath, "utf8")),
    );
    expect(fresh.binding.analysis_profile).toEqual(profile);
    expect(f.starts()).toBe(1);
    expect(await readFile(f.snapshotPath, "utf8")).toBe(original);
  },
);

it("reopens a matching Hopper producer snapshot while keeping observations live", async () => {
  const f = await fixture();
  await f.open();
  const first = parseEvidence((await f.call(query)).structuredContent);
  expect(first.analysis_profile?.parameters.producer).toEqual(
    hopperProducerIdentity(),
  );
  expect(first.analysis_profile?.parameters).not.toHaveProperty(
    "function_dossier_coverage",
  );
  await f.save();
  const snapshot = parseAnalysisSnapshot(
    JSON.parse(await readFile(f.snapshotPath, "utf8")),
  );
  expect(snapshot.binding.analysis_profile).toEqual(first.analysis_profile);
  expect(snapshot.entries).toEqual([]);
  expect(snapshot.evidence_bundle.records).toContainEqual(first);

  await f.close();
  const reopened = await fixture(f.root);
  expect(reopened.session.evidenceById(first.evidence_id)).toBeUndefined();
  await reopened.open(f.snapshotPath);
  const evidencePath = join(f.root, "restored-evidence.json");
  await reopened.call({
    name: "export_evidence_bundle",
    arguments: { path: evidencePath },
  });
  const restored = evidenceBundleSchema.parse(
    JSON.parse(await readFile(evidencePath, "utf8")),
  );
  expect(restored.records).toContainEqual(first);
  expect(reopened.reads()).toBe(0);
  expect(reopened.starts()).toBe(0);

  const second = parseEvidence((await reopened.call(query)).structuredContent);
  expect(second.analysis_profile).toEqual(first.analysis_profile);
  expect(second.evidence_id).toBe(first.evidence_id);
  expect(f.reads()).toBe(1);
  expect(f.starts()).toBe(1);
  expect(reopened.reads()).toBe(1);
  expect(reopened.starts()).toBe(1);
});
