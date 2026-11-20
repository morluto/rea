import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import {
  locateApkSigningBlock,
  parseZipTail,
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

cliTest(
  "keeps fixed APK pair refusals nonretryable through CLI and MCP, then accepts a valid input",
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
    const tail = parseZipTail(bytes);
    if (!tail.ok) throw new Error("Expected a framed ZIP tail");
    const parsed = locateApkSigningBlock(bytes, tail.value);
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
        refusal: {
          kind: "fixed_ceiling",
          operation: "inspect_apk_signature",
          allowance_kind: "count",
        },
      },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await cli.run({
        arguments: ["inspect-apk-signature", paths.get(4097)!, "--json"],
      });
      expect(reply.exitCode, reply.stderr).toBe(1);
      const error = analysisErrorProjectionSchema.parse(reply.json);
      expect(error).toMatchObject(expected);
      expect(error.remediation.action).toContain("4096");
    }
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
  "preserves the fixed signer and lineage refusals through CLI and MCP",
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
      expect(error).toMatchObject({
        code: "resource_constraint",
        retryable: false,
        details: {
          operation: "inspect_apk_signature",
          resource: "capacity",
          reason: `APK Signature Scheme ${scheme} holds more ${boundary} than the 32 limit.`,
        },
      });
      expect(error.details?.reported_limits).toEqual({ [key]: 32 });
      expect(error.remediation.action).toBe(
        `The APK Signature Scheme ${scheme} allowance of 32 ${boundary} (this release has no runtime override) is a fixed count. Waiting for an active analysis to finish does not raise it. Repeating the unchanged request fails the same way.`,
      );
      const rejected = await call("inspect_apk_signature", { path });
      expect(parseMcpToolError(rejected).error).toEqual(error);
    }
  },
);
