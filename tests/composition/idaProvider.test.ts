import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IdaProvider } from "../../src/ida/IdaProvider.js";
import { createIdaTarget, RecordingIdaMcp } from "../fixtures/idaMcp.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";
import { parseConfig } from "../../src/config.js";
import {
  createAnalysisSnapshotEntry,
  snapshotBinding,
  snapshotTarget,
} from "../../src/domain/analysisSnapshot.js";
import { createEvidence } from "../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import { createAnalysisExecution } from "../../src/application/AnalysisProvider.js";
import { IDA_PROVIDER_IDENTITY } from "../../src/ida/IdaProvider.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("IDA provider composition", () => {
  it("discovers without launching and commits adapter semantics without persisting credentials", async () => {
    const { root, target } = await createIdaTarget();
    roots.push(root);
    const path = join(root, "registration.json");
    await writeFile(
      path,
      JSON.stringify({
        url: "http://127.0.0.1:8745/mcp",
        headers: { Authorization: "Bearer private-fixture-token" },
        mode: "headless",
      }),
    );
    const config = parseConfig({ REA_IDA_MCP_CONFIG: path });
    if (!config.ok) throw config.error;
    const producer = new RecordingIdaMcp(target, "headless");
    const provider = new IdaProvider(config.value, {}, () => producer);
    expect(provider.inspectAvailability()).toMatchObject({
      status: "available",
      diagnostics: { live_connection_probed: false },
    });
    const resolution = await provider.resolveAnalysisProfile(target);
    if (!resolution.ok) throw resolution.error;
    expect(resolution.value.profile.parameters).toMatchObject({
      engine_version: null,
      upstream_distribution_version: null,
      cache_policy: "live",
      version_scope: "rea-ida-adapter",
    });
    expect(JSON.stringify(resolution)).not.toContain("private-fixture-token");
    expect(producer.connects).toBe(0);
    expect(
      provider
        .capabilities()
        .find(({ operation }) => operation === "procedure_callers")?.available,
    ).toBe(false);
  });
  it("re-observes externally mutable state even when a document is explicit and a snapshot is imported", async () => {
    const { root, target } = await createIdaTarget();
    roots.push(root);
    const path = join(root, "registration.json");
    await writeFile(path, JSON.stringify({ command: "fixture" }));
    const config = parseConfig({ REA_IDA_MCP_CONFIG: path });
    if (!config.ok) throw config.error;
    const producer = new RecordingIdaMcp(target);
    const session = createTestBinarySession(
      new IdaProvider(config.value, {}, () => producer),
    );
    expect((await session.open(target.path)).ok).toBe(true);
    const query = { procedure: "main", document: target.path };
    const first = await session.execute("procedure_pseudo_code", query);
    expect(first.ok && first.value.result).toContain("42");
    const snapshot = session.exportAnalysisSnapshot();
    if (!snapshot.ok) throw snapshot.error;
    expect(snapshot.value.entries).toEqual([]);
    const profile = session.analysisProfile();
    if (profile === undefined) throw new Error("Missing profile");
    const cached = createAnalysisExecution(
      "stale output",
      IDA_PROVIDER_IDENTITY,
      {
        analysisProfile: profile,
        subject: {
          path: target.path,
          sha256: target.sha256,
          format: target.format,
          ...(target.architecture === undefined
            ? {}
            : { architecture: target.architecture }),
        },
      },
    );
    snapshot.value.entries.push(
      createAnalysisSnapshotEntry({
        target: snapshotTarget(target),
        binding: snapshotBinding(profile),
        operation: "procedure_pseudo_code",
        parameters: query,
        execution: cached,
      }),
    );
    snapshot.value.evidence_bundle = createEvidenceBundle([
      ...snapshot.value.evidence_bundle.records,
      createEvidence(target, IDA_PROVIDER_IDENTITY, {
        operation: "procedure_pseudo_code",
        parameters: query,
        result: cached.result,
        rawResult: cached.rawResult,
        analysisProfile: profile,
      }),
    ]);
    expect(session.importAnalysisSnapshot(snapshot.value).ok).toBe(true);
    expect(session.allowsSnapshotReplay("procedure_pseudo_code")).toBe(false);
    expect(session.allowsSnapshotReplay("binary_overview")).toBe(false);
    producer.pseudocode = "int main(void) { return 99; }";
    const second = await session.execute("procedure_pseudo_code", query);
    expect(second.ok && second.value.result).toContain("99");
    expect(
      producer.calls.filter(({ name }) => name === "decompile_function"),
    ).toHaveLength(2);
    await session.close();
    expect(producer.closes).toBe(1);
  });
  it("rejects unsupported target kinds and reports incomplete upstream profiles on first analysis", async () => {
    const { root, target } = await createIdaTarget();
    roots.push(root);
    const path = join(root, "registration.json");
    await writeFile(
      path,
      JSON.stringify({
        command: "fixture",
        mode: "headless",
        workspaceRoot: root,
      }),
    );
    const config = parseConfig({ REA_IDA_MCP_CONFIG: path });
    if (!config.ok) throw config.error;
    const producer = new RecordingIdaMcp(target);
    const provider = new IdaProvider(config.value, {}, () => producer);
    expect(
      provider.inspectTargetSupport({
        path: target.path,
        sha256: target.sha256,
        kind: "database",
        format: "analysis-database",
      }),
    ).toMatchObject({ status: "unsupported", code: "target_kind_unsupported" });
    const session = createTestBinarySession(provider);
    expect((await session.open(target.path)).ok).toBe(true);
    expect(producer.connects).toBe(0);
    const analyzed = await session.execute("procedure_pseudo_code", {
      procedure: "main",
    });
    expect(analyzed).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisProtocolError",
        message: expect.stringContaining(
          "headless compatibility profile is missing tools: idb_open",
        ),
      },
    });
    expect(producer.connects).toBe(1);
    expect((await session.close()).ok).toBe(true);
    expect(producer.closes).toBe(1);
  });
});
