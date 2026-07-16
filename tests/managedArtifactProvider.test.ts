import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runProviderAnalysis } from "../src/application/DirectAnalysis.js";
import type { AnalysisExecution } from "../src/application/AnalysisProvider.js";
import { managedArtifactInspectionSchema } from "../src/domain/managedArtifact.js";
import type { BinaryTarget } from "../src/domain/binaryTarget.js";
import { parseBinaryTarget } from "../src/domain/binaryTarget.js";
import { parseEvidence } from "../src/domain/evidence.js";
import { ManagedStaticProvider } from "../src/dotnet/ManagedStaticProvider.js";
import { inspectManagedArtifactBytes } from "../src/dotnet/ManagedArtifactInspector.js";
import {
  buildManagedPeFixture,
  buildNativePeFixture,
} from "./fixtures/managedPe.js";

const limits = {
  referenceOffset: 0,
  referenceLimit: 100,
  resourceOffset: 0,
  resourceLimit: 100,
  attributeOffset: 0,
  attributeLimit: 100,
  maxMetadataBytes: 1024 * 1024,
  maxTableRows: 1_000,
  maxHeapItemBytes: 1024 * 1024,
};

describe("managed PE/CLI static provider", () => {
  it("inventories module, assembly, framework, references, and resources without loading CLR code", () => {
    const resource = Buffer.from("source-owned resource");
    const bytes = buildManagedPeFixture({ resourceData: resource });
    const result = inspectManagedArtifactBytes(bytes, target(bytes), limits);

    expect(result.classification).toMatchObject({
      status: "managed",
      runtime_family: "modern-dotnet",
      implementation: "cil",
      managed_architecture: "anycpu",
    });
    expect(result.pe.cli).toMatchObject({
      flag_names: ["il-only"],
      entry_point: { kind: "metadata-token", value: "0x06000001" },
    });
    expect(result.module).toMatchObject({
      name: "Fixture.dll",
      mvid: "00112233-4455-6677-8899-aabbccddeeff",
      token: "0x00000001",
    });
    expect(result.assembly).toMatchObject({
      name: "Fixture.Managed",
      version: "1.2.3.4",
      token: "0x20000001",
    });
    expect(result.target_frameworks).toEqual([".NETCoreApp,Version=v8.0"]);
    expect(result.references).toMatchObject({
      total: 1,
      returned: 1,
      complete: true,
      items: [expect.objectContaining({ name: "System.Runtime" })],
    });
    expect(result.resources.items).toEqual([
      expect.objectContaining({
        name: "Fixture.resources",
        embedded: true,
        visibility: "private",
        data_length: resource.length,
        data_sha256: createHash("sha256").update(resource).digest("hex"),
      }),
    ]);
    expect(result.coverage).toMatchObject({ state: "complete", issues: [] });
  });

  it("keeps classification evidence complete when caller pages visible references", () => {
    const bytes = buildManagedPeFixture({
      references: ["System.Runtime", "UnityEngine.CoreModule"],
    });
    const result = inspectManagedArtifactBytes(bytes, target(bytes), {
      ...limits,
      referenceLimit: 1,
    });

    expect(result.classification.runtime_family).toBe("unity-mono");
    expect(result.references).toMatchObject({
      total: 2,
      returned: 1,
      complete: false,
    });
    expect(result.coverage.state).toBe("partial");
    expect(result.coverage.issues).toEqual([]);
  });

  it("reports native PE, malformed metadata, and bounded metadata failures as typed results", () => {
    const native = inspectManagedArtifactBytes(
      buildNativePeFixture(),
      target(buildNativePeFixture()),
      limits,
    );
    expect(native.classification.status).toBe("not-managed");
    expect(native.metadata.status).toBe("absent");
    expect(native.coverage.state).toBe("unavailable");

    const malformedBytes = buildManagedPeFixture({
      corruptMetadataSignature: true,
    });
    const malformed = inspectManagedArtifactBytes(
      malformedBytes,
      target(malformedBytes),
      limits,
    );
    expect(malformed.classification.status).toBe("malformed");
    expect(malformed.coverage.issues).toEqual([
      expect.objectContaining({ code: "invalid-metadata-root" }),
    ]);

    const unsupportedTableBytes = buildManagedPeFixture({
      metadataValidMaskExtra: 1n << 50n,
    });
    const unsupportedTable = inspectManagedArtifactBytes(
      unsupportedTableBytes,
      target(unsupportedTableBytes),
      limits,
    );
    expect(unsupportedTable.coverage.issues).toEqual([
      expect.objectContaining({ code: "invalid-tables" }),
    ]);

    const limited = inspectManagedArtifactBytes(
      buildManagedPeFixture(),
      target(buildManagedPeFixture()),
      { ...limits, maxMetadataBytes: 256 },
    );
    expect(limited.metadata.status).toBe("partial");
    expect(limited.coverage.issues).toEqual([
      expect.objectContaining({ code: "limit-exceeded" }),
    ]);
  });

  it("executes as a read-only auxiliary provider with digest, cancellation, and format boundaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-managed-provider-"));
    const bytes = buildManagedPeFixture();
    const path = join(directory, "fixture.exe");
    await writeFile(path, bytes);
    const parsed = await parseBinaryTarget(path);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const client = new ManagedStaticProvider().createClient(parsed.value);
    const observed = await client.execute("inspect_managed_artifact", {});
    expect(observed.ok).toBe(true);
    if (!observed.ok) return;
    expect(asManagedResult(observed.value)).toMatchObject({
      classification: { status: "managed", runtime_family: "modern-dotnet" },
      artifact: { path, sha256: parsed.value.sha256, format: "pe" },
    });
    expect(observed.value.provider.id).toBe("rea-dotnet-static");
    expect(observed.value.subject).toMatchObject({ path, format: "pe" });

    const cancelled = new AbortController();
    cancelled.abort();
    const cancelledResult = await client.execute(
      "inspect_managed_artifact",
      {},
      { signal: cancelled.signal },
    );
    expect(cancelledResult).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });

    const changed = Buffer.from(bytes);
    changed[0x300] = 0;
    await writeFile(path, changed);
    const staleDigest = await client.execute("inspect_managed_artifact", {});
    expect(staleDigest).toMatchObject({
      ok: false,
      error: { _tag: "EvidenceIntegrityError" },
    });

    await client.close();
    const nativeClient = new ManagedStaticProvider().createClient({
      ...parsed.value,
      format: "elf",
    });
    await expect(
      nativeClient.execute("inspect_managed_artifact", {}),
    ).resolves.toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError" },
    });
  });

  it("has the same evidence shape through direct CLI analysis plumbing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-managed-cli-"));
    const path = join(directory, "fixture.exe");
    await writeFile(path, buildManagedPeFixture());

    const evidence = parseEvidence(
      await runProviderAnalysis(path, "inspect_managed_artifact", {
        reference_limit: 1,
      }),
    );
    expect(evidence).toMatchObject({
      operation: "inspect_managed_artifact",
      provider: { id: "rea-dotnet-static" },
      subject: { local_path: path, format: "pe" },
      normalized_result: {
        classification: { status: "managed", runtime_family: "modern-dotnet" },
        references: { limit: 1 },
      },
    });
  });
});

const target = (bytes: Buffer): BinaryTarget => ({
  path: "/fixture.exe",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  kind: "executable",
  format: "pe",
  architecture: "x86",
  availableArchitectures: ["x86"],
});

const asManagedResult = (execution: AnalysisExecution) =>
  managedArtifactInspectionSchema.parse(execution.result);
