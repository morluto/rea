import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import {
  locateApkSigningBlockFromReader,
  parseZipTailFromReader,
} from "../../src/domain/apkSignature/apkSigningBlock.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { analysisErrorProjectionSchema } from "../../src/domain/analysisErrorProjectionSchema.js";
import { apkSignatureSummaryViewResultSchema } from "../../src/domain/analysisView/analysisViewResult.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  APK_SIGNATURE_V2_ID,
  APK_SIGNATURE_V3_ID,
  LEAF_CERTIFICATE,
  v2SchemeValue,
  v3SchemeValue,
  withSigningBlock,
  zipWith,
} from "../fixtures/apkSignature/v1SignatureBlock.js";
import { cliTest } from "../support/cli/cliFixture.js";
import { bufferByteSource } from "../../src/domain/byteSource.js";

cliTest(
  "reports per-call APK pair refusals nonretryable through CLI and MCP, then accepts raised and valid inputs",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-apk-pair-limit-");
    const archive = await zipWith([
      { name: "AndroidManifest.xml", data: Uint8Array.of(3, 0, 8, 0) },
    ]);
    const paths = new Map<number, string>();
    const digests = new Map<number, string>();
    const malformedPath = join(root, "pair-overrun.apk");
    for (const count of [1, 4096, 4097]) {
      const path = join(root, `pairs-${count}.apk`);
      const bytes = withSigningBlock(
        archive,
        Array.from({ length: count }, () => ({
          id: 0xffffffff,
          value: new Uint8Array(),
        })),
      );
      await writeFile(path, bytes);
      digests.set(count, createHash("sha256").update(bytes).digest("hex"));
      paths.set(count, path);
      if (count === 4097) {
        const malformed = Buffer.from(bytes);
        const directoryOffset = malformed.readUInt32LE(
          malformed.length - 22 + 16,
        );
        // The last pair has room for its ID only. Its declared value would
        // cross into the 24-byte block footer.
        malformed.writeBigUInt64LE(5n, directoryOffset - 24 - 12);
        await writeFile(malformedPath, malformed);
      }
    }
    const bytes = await readFile(paths.get(4097)!);
    const reader = bufferByteSource(bytes, 4);
    const tail = await parseZipTailFromReader(reader);
    if (!tail.ok) throw new Error("Expected a framed ZIP tail");
    const parsed = await locateApkSigningBlockFromReader(
      reader,
      tail.value.tail,
    );
    if (parsed.ok || parsed.error.kind !== "limit")
      throw new Error("Expected a signing-block pair limit");
    const expected = {
      code: "resource_constraint",
      category: "resource_constraint",
      retryable: false,
      details: {
        operation: "inspect_apk_signature",
        resource: "capacity",
        reason: parsed.error.failure.detail,
        reported_limits: { max_signing_block_pairs: 4096 },
        limit: {
          control_kind: "parameter",
          parameter: "max_signing_block_pairs",
          effective_value: 4096,
          default_value: 4096,
          maximum: 65536,
          unit: "count",
          applies_at: "next_call",
        },
      },
    };
    const reply = await cli.run({
      arguments: ["inspect-apk-signature", paths.get(4097)!, "--json"],
    });
    expect(reply.exitCode, reply.stderr).toBe(1);
    const error = analysisErrorProjectionSchema.parse(reply.json);
    expect(error).toMatchObject({
      ...expected,
      details: {
        ...expected.details,
        limit: {
          ...expected.details.limit,
          cli_flag: "--max-signing-block-pairs",
        },
      },
    });
    const raisedPairs = await cli.run({
      arguments: [
        "inspect-apk-signature",
        paths.get(4097)!,
        "--max-signing-block-pairs",
        "4097",
        "--json",
      ],
    });
    expect(raisedPairs.exitCode, raisedPairs.stderr).toBe(0);
    const malformedExpected = {
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["path"],
            reason: "invalid_value",
            message: expect.stringContaining("pair length out of range"),
          },
        ],
      },
    };
    const malformedReply = await cli.run({
      arguments: ["inspect-apk-signature", malformedPath, "--json"],
    });
    expect(malformedReply.exitCode, malformedReply.stderr).toBe(1);
    expect(
      analysisErrorProjectionSchema.parse(malformedReply.json),
    ).toMatchObject(malformedExpected);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
    });
    const rejected = await call("inspect_apk_signature", {
      path: paths.get(4097),
    });
    expect(parseMcpToolError(rejected).error).toMatchObject(expected);
    const malformed = await call("inspect_apk_signature", {
      path: malformedPath,
    });
    expect(parseMcpToolError(malformed).error).toMatchObject(malformedExpected);
    for (const count of [4096, 1]) {
      const path = paths.get(count)!;
      const reply = await call("inspect_apk_signature", { path });
      expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
      const report = apkSignatureSummaryViewResultSchema.parse(
        parseEvidence(reply.structuredContent).normalized_result,
      ).summary;
      expect(report.artifact.path).toBe(path);
      expect(report.artifact.sha256).toBe(digests.get(count));
      expect(report.posture.strongest_scheme).toBe("none");
    }
  },
);

cliTest(
  "reports per-call signer and lineage refusals through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-apk-scheme-limit-");
    const archive = await zipWith([
      { name: "AndroidManifest.xml", data: Uint8Array.of(3, 0, 8, 0) },
    ]);
    const signer = v2SchemeValue(LEAF_CERTIFICATE).subarray(4);
    const signerLength = Buffer.alloc(4);
    signerLength.writeUInt32LE(signer.length * 33);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
    });
    for (const { id, value, scheme, boundary, key } of [
      {
        id: APK_SIGNATURE_V2_ID,
        value: Buffer.concat([
          signerLength,
          ...Array.from({ length: 33 }, () => signer),
        ]),
        scheme: "v2",
        boundary: "signers",
        key: "max_signers",
      },
      {
        id: APK_SIGNATURE_V3_ID,
        value: v3SchemeValue(
          null,
          Array.from({ length: 33 }, () => LEAF_CERTIFICATE),
        ),
        scheme: "v3",
        boundary: "lineage-nodes",
        key: "max_lineage_nodes",
      },
    ]) {
      const path = join(root, `${scheme}.apk`);
      await writeFile(path, withSigningBlock(archive, [{ id, value }]));
      const reply = await cli.run({
        arguments: ["inspect-apk-signature", path, "--json"],
      });
      expect(reply.exitCode, reply.stderr).toBe(1);
      const error = analysisErrorProjectionSchema.parse(reply.json);
      const expected = {
        code: "resource_constraint",
        retryable: false,
        details: {
          operation: "inspect_apk_signature",
          resource: "capacity",
          reason: `APK Signature Scheme ${scheme} holds more ${boundary} than the 32 limit.`,
          reported_limits: { [key]: 32 },
          limit: {
            control_kind: "parameter",
            parameter: key,
            effective_value: 32,
            default_value: 32,
            maximum: 1024,
            unit: "count",
            applies_at: "next_call",
          },
        },
      };
      expect(error).toMatchObject({
        ...expected,
        details: {
          ...expected.details,
          limit: {
            ...expected.details.limit,
            cli_flag: `--${key.replaceAll("_", "-")}`,
          },
        },
      });
      const rejected = await call("inspect_apk_signature", { path });
      expect(parseMcpToolError(rejected).error).toMatchObject(expected);
      const raised = await call("inspect_apk_signature", {
        path,
        [key]: 33,
      });
      expect(raised.isError, JSON.stringify(raised.content)).not.toBe(true);
    }
  },
);

cliTest(
  "keeps omitted budget defaults out of MCP Evidence parameters and records caller-selected budgets",
  async () => {
    const root = await createTestTempDirectory("rea-apk-mcp-params-");
    const path = join(root, "unsigned.apk");
    await writeFile(
      path,
      await zipWith([
        { name: "AndroidManifest.xml", data: Uint8Array.of(3, 0, 8, 0) },
      ]),
    );
    const { call } = await connectLocalToolsMcp({
      REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
    });

    const omitted = await call("inspect_apk_signature", {
      path,
      detail: "complete",
    });
    expect(omitted.isError, JSON.stringify(omitted.content)).not.toBe(true);
    expect(parseEvidence(omitted.structuredContent).parameters).toEqual({
      path,
    });

    const explicit = await call("inspect_apk_signature", {
      path,
      detail: "complete",
      max_signers: 40,
      max_output_bytes: 1024 * 1024,
    });
    expect(explicit.isError, JSON.stringify(explicit.content)).not.toBe(true);
    expect(parseEvidence(explicit.structuredContent).parameters).toEqual({
      path,
      max_signers: 40,
      max_output_bytes: 1024 * 1024,
    });
  },
);
