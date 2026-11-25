import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import {
  backupImage,
  backupTar,
  encryptedBackupImage,
  paxRecord,
} from "../../fixtures/androidBackup.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { connectArtifactComparisonMcp } from "../../fixtures/artifactComparisonMcp.js";

it("preserves offline Android backup facts through the advertised MCP schemas", async () => {
  const root = await createTestTempDirectory("rea-ab-mcp-");
  const path = join(root, "backup.ab");
  const outputRoot = join(root, "output");
  const payload = "selected bytes";
  const image = backupImage(
    backupTar([{ path: "apps/sample/f/value.txt", data: payload }]),
    { compressed: true },
  );
  await writeFile(path, image);
  const { call } = await connectLocalToolsMcp({
    REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact",
    REA_MCP_TOOL_FAMILIES: "session,artifact",
  });
  expect((await call("open_binary", { path })).isError).not.toBe(true);
  const limited = await call("inspect_artifact", {
    artifact_limits: { android_backup: { encoded_bytes: 1 } },
  });
  expect(parseMcpToolError(limited).error.details).toMatchObject({
    reason: "limit",
    reader_limit: {
      parameter: "artifact_limits.android_backup.encoded_bytes",
      effective_value: 1,
      can_increase: true,
    },
  });
  const reply = await call("inspect_artifact", {
    artifact_limits: { android_backup: { encoded_bytes: image.length } },
  });
  expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
  const evidence = parseEvidence(reply.structuredContent);
  const graph = artifactInspectionResultSchema.parse(evidence.normalized_result)
    .substeps[0]!.evidence.normalized_result;
  expect(graph.manifest).toMatchObject({
    root_format: "android-backup",
    root_sha256: createHash("sha256").update(image).digest("hex"),
  });
  expect(graph.coverage).toMatchObject({ status: "complete" });
  const member = graph.occurrences.find(
    (row) => row.logical_path === "apps/sample/f/value.txt",
  )!;
  expect(member).toMatchObject({
    hash_status: "verified",
    source_location: null,
    format_metadata: {
      kind: "android-backup-entry",
      tar_header_offset: 0,
      tar_data_offset: 512,
    },
  });
  const extracted = await call("extract_artifact", {
    output_root: outputRoot,
    occurrence_ids: [member.occurrence_id],
  });
  expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
  expect(
    artifactExtractionResultSchema.parse(
      parseEvidence(extracted.structuredContent).normalized_result,
    ),
  ).toMatchObject({ output_root: outputRoot, containment_verified: true });
  expect(await readFile(join(outputRoot, member.logical_path), "utf8")).toBe(
    payload,
  );
  expect((await readFile(path)).equals(image)).toBe(true);
  await call("close_binary", {});
  const invalid = backupTar([
    { path: "apps/sample/f/value.txt", data: payload },
  ]);
  invalid[0] = 0x78;
  await writeFile(path, backupImage(invalid));
  expect((await call("open_binary", { path })).isError).not.toBe(true);
  const failed = await call("inspect_artifact", {});
  expect(failed.isError).toBe(true);
  expect(JSON.stringify(failed)).toContain("checksum");
  await call("close_binary", {});
  await writeFile(path, encryptedBackupImage());
  expect((await call("open_binary", { path })).isError).not.toBe(true);
  const encrypted = await call("inspect_artifact", {});
  expect(encrypted.isError, JSON.stringify(encrypted)).not.toBe(true);
  const unknown = artifactInspectionResultSchema.parse(
    parseEvidence(encrypted.structuredContent).normalized_result,
  ).substeps[0]!.evidence.normalized_result;
  expect(unknown.coverage).toMatchObject({ status: "unknown" });
  expect(unknown.occurrences).toMatchObject([
    {
      encrypted: true,
      format_metadata: {
        directory_status: "encrypted",
        payload_offset: null,
      },
    },
  ]);
  const refusedRoot = join(root, "refused");
  expect(
    (await call("extract_artifact", { output_root: refusedRoot })).isError,
  ).toBe(true);
  await expect(lstat(refusedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  await call("close_binary", {});
}, 60_000);

it("compares effective member declarations independently of backup encoding", async () => {
  const root = await createTestTempDirectory("rea-ab-comparison-");
  const { inspect, compare } = await connectArtifactComparisonMcp();
  const observations = [];
  const memberPath = "apps/sample/f/value.txt";
  for (const [name, compressed, usePax, mode] of [
    ["plain", false, false, 0o600],
    ["compressed", true, false, 0o600],
    ["pax", true, true, 0o600],
    ["mode", true, true, 0o640],
  ] as const) {
    const path = join(root, `${name}.ab`);
    await writeFile(
      path,
      backupImage(
        backupTar([
          ...(usePax
            ? [
                { path: "Pax", type: "x", data: paxRecord("path", memberPath) },
                { path: "placeholder", data: "same bytes", mode },
              ]
            : [
                {
                  path: "value.txt",
                  prefix: "apps/sample/f",
                  data: "same bytes",
                  mode,
                },
              ]),
        ]),
        { compressed },
      ),
    );
    observations.push(await inspect(path));
  }
  for (const alternative of observations.slice(1, 3)) {
    const same = await compare(observations[0]!, alternative);
    expect(
      same.changes.filter(({ logical_path }) => logical_path !== "."),
    ).toEqual([]);
  }
  expect(observations[2]!.normalized_result).toMatchObject({
    occurrences: expect.arrayContaining([
      expect.objectContaining({
        logical_path: memberPath,
        format_metadata: expect.objectContaining({ pax: { path: memberPath } }),
      }),
    ]),
  });
  const changed = await compare(observations[2]!, observations[3]!);
  expect(
    changed.changes.find(
      ({ logical_path }) => logical_path === "apps/sample/f/value.txt",
    ),
  ).toMatchObject({ classification: "changed", dimensions: ["metadata"] });
}, 60_000);
