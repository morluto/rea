import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { ok } from "../../domain/result.js";
import { v8CodeCacheFixture } from "../../v8/V8CodeCache.fixture.js";
import { parseV8CodeCacheFromHandle } from "../../v8/V8CodeCacheParser.js";
import { V8CodeCacheService } from "./V8CodeCacheService.js";

it("admits complete V8 coverage only when the scanned bytes match the payload", async () => {
  const bytes = v8CodeCacheFixture();
  const path = "/artifacts/module.jsc";
  const report = await parseV8CodeCacheFromHandle(
    {
      size: bytes.length,
      prefix: bytes,
      readRange: async () => {
        throw new Error("The admitted prefix already contains the test cache");
      },
    },
    {
      path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    { min_string_bytes: 4, max_strings: 4096 },
  );
  let scanned_bytes = report.payload.bytes;
  const service = new V8CodeCacheService({
    identity: { id: "cache-fixture", name: "Cache fixture", version: "1" },
    close: async () => {},
    inspect: async () =>
      ok({
        ...report,
        coverage: { ...report.coverage, scanned_bytes },
      }),
  });
  expect(await service.inspect({ path })).toMatchObject({ ok: true });
  for (const count of [0, report.payload.bytes + 1]) {
    scanned_bytes = count;
    const result = await service.inspect({ path });
    if (result.ok)
      throw new Error(`Accepted complete coverage with ${String(count)} bytes`);
    expect(result.error).toBeInstanceOf(AnalysisOutputError);
  }
});
