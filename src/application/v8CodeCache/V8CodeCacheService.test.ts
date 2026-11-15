import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { parseEvidence } from "../../domain/evidence.js";
import { ok } from "../../domain/result.js";
import {
  V8_CODE_CACHE_HEADER_BYTES,
  V8_CODE_CACHE_MAGIC_HIGH,
  type V8CodeCache,
} from "../../domain/v8/v8CodeCache.js";
import { parseV8CodeCache } from "../../v8/V8CodeCacheParser.js";
import { V8CodeCacheService } from "./V8CodeCacheService.js";

const reportFor = (payloadBytes: number): V8CodeCache => {
  const bytes = Buffer.alloc(V8_CODE_CACHE_HEADER_BYTES + payloadBytes, 0x61);
  bytes.fill(0, 0, V8_CODE_CACHE_HEADER_BYTES);
  bytes.writeUInt32LE(V8_CODE_CACHE_MAGIC_HIGH * 0x10000, 0);
  bytes.writeUInt32LE(payloadBytes, 20);
  return parseV8CodeCache(
    bytes,
    {
      path: "/artifacts/authored.jsc",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
    { min_string_bytes: 4, max_strings: 8 },
  );
};

const inspect = (report: V8CodeCache) =>
  new V8CodeCacheService({
    identity: { id: "cache-fixture", name: "Cache fixture", version: "1" },
    close: async () => {},
    inspect: async () => ok(report),
  }).inspect({ path: report.artifact.path });

it.each([0, 9])(
  "rejects complete coverage claiming %s scanned bytes for an eight-byte payload",
  async (scanned_bytes) => {
    const report = reportFor(8);
    const result = await inspect({
      ...report,
      coverage: { ...report.coverage, scanned_bytes },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
  },
);

it.each([8, 5000])(
  "retains complete scan facts for a %s-byte payload and its bounded string prefix",
  async (payloadBytes) => {
    const report = reportFor(payloadBytes);
    const result = await inspect(report);
    if (!result.ok) throw result.error;
    expect(parseEvidence(result.value).normalized_result).toMatchObject({
      coverage: { status: "complete", scanned_bytes: payloadBytes, strings: 1 },
      embedded_strings: [
        {
          bytes: payloadBytes,
          retained_bytes: Math.min(payloadBytes, 4096),
          truncated: payloadBytes > 4096,
        },
      ],
    });
  },
);
