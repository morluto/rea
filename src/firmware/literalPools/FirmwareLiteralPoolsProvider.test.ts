import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { FirmwareLiteralPoolsProvider } from "./FirmwareLiteralPoolsProvider.js";

const DEFAULTS = {
  scan_offset: 0,
  max_scan_bytes: 1024 * 1024,
  max_references: 16_384,
  max_svd_nodes: 200_000,
  max_file_bytes: 32 * 1024 * 1024,
} as const;

describe("FirmwareLiteralPoolsProvider", () => {
  it("honors cancellation during literal-pool scanning and returns typed failures", async () => {
    const dir = await createTestTempDirectory("rea-literal-pools-provider-");
    const fwPath = join(dir, "large_thumb.bin");
    const image = Buffer.alloc(192 * 1024, 0x00);
    for (let p = 0; p < image.length - 8; p += 2) {
      image.writeUInt16LE(0xbf00, p);
    }
    image.writeUInt16LE(0x4800, 0x00);
    image.writeUInt32LE(0xe000_ed08, 0x04);
    await writeFile(fwPath, image);

    const provider = new FirmwareLiteralPoolsProvider();

    const preAbort = new AbortController();
    const preReason = new Error("caller-cancelled-before-scan");
    preAbort.abort(preReason);
    const cancelledBefore = await provider.inspect(
      {
        ...DEFAULTS,
        path: fwPath,
        isa: "arm-thumb",
        base_address: "0x08000000",
      },
      { signal: preAbort.signal },
    );
    expect(cancelledBefore.ok).toBe(false);
    if (!cancelledBefore.ok) {
      expect(cancelledBefore.error._tag).toBe("AnalysisCancelledError");
      expect(cancelledBefore.error.cause).toBe(preReason);
    }

    const midAbort = new AbortController();
    const midReason = new Error("caller-cancelled-mid-scan");
    const running = provider.inspect(
      {
        ...DEFAULTS,
        path: fwPath,
        isa: "arm-thumb",
        base_address: "0x08000000",
      },
      { signal: midAbort.signal },
    );
    setTimeout(() => midAbort.abort(midReason), 0);
    const cancelledMid = await running;
    if (!cancelledMid.ok) {
      expect(cancelledMid.error._tag).toBe("AnalysisCancelledError");
    }

    const badAlign = await provider.inspect({
      ...DEFAULTS,
      path: fwPath,
      isa: "arm-thumb",
      base_address: "0x08000001",
    });
    expect(badAlign.ok).toBe(false);
    if (!badAlign.ok) {
      expect(badAlign.error._tag).toBe("AnalysisInputError");
    }

    const badSvd = await provider.inspect({
      ...DEFAULTS,
      path: fwPath,
      isa: "arm-thumb",
      base_address: "0x08000000",
      svd_xml: "<notDevice/>",
    });
    expect(badSvd.ok).toBe(false);
    if (!badSvd.ok) {
      expect(badSvd.error._tag).toBe("AnalysisInputError");
    }

    const manyPeripherals = Array.from(
      { length: 20 },
      (_, idx) =>
        `<peripheral><name>P${String(idx)}</name><baseAddress>0x40000000</baseAddress><addressBlock><offset>0x0</offset><size>0x10</size><usage>registers</usage></addressBlock></peripheral>`,
    ).join("");
    const svdLimitRes = await provider.inspect({
      ...DEFAULTS,
      path: fwPath,
      isa: "arm-thumb",
      base_address: "0x08000000",
      svd_xml: `<device><peripherals>${manyPeripherals}</peripherals></device>`,
      max_svd_nodes: 24,
    });
    expect(svdLimitRes.ok).toBe(false);
    if (!svdLimitRes.ok) {
      expect(svdLimitRes.error._tag).toBe("AnalysisResourceConstraintError");
      expect(svdLimitRes.error.limit).toMatchObject({
        control_kind: "parameter",
        parameter: "max_svd_nodes",
        effective_value: 24,
      });
    }

    const fileLimitRes = await provider.inspect({
      ...DEFAULTS,
      path: fwPath,
      isa: "arm-thumb",
      base_address: "0x08000000",
      max_file_bytes: 64,
    });
    expect(fileLimitRes.ok).toBe(false);
    if (!fileLimitRes.ok) {
      expect(fileLimitRes.error._tag).toBe("AnalysisResourceConstraintError");
      expect(fileLimitRes.error.limit).toMatchObject({
        control_kind: "parameter",
        parameter: "max_file_bytes",
        effective_value: 64,
      });
    }

    const twoLoads = Buffer.alloc(16, 0x00);
    twoLoads.writeUInt16LE(0x4801, 0x00);
    twoLoads.writeUInt16LE(0x4901, 0x02);
    twoLoads.writeUInt32LE(0xe000_ed08, 0x08);
    const twoLoadsPath = join(dir, "two_loads.bin");
    await writeFile(twoLoadsPath, twoLoads);
    const refLimitRes = await provider.inspect({
      ...DEFAULTS,
      path: twoLoadsPath,
      isa: "arm-thumb",
      base_address: "0x08000000",
      max_references: 1,
    });
    expect(refLimitRes.ok).toBe(false);
    if (!refLimitRes.ok) {
      expect(refLimitRes.error._tag).toBe("AnalysisResourceConstraintError");
      expect(refLimitRes.error.limit).toMatchObject({
        control_kind: "parameter",
        parameter: "max_references",
        effective_value: 1,
      });
    }

    await provider.close();
  });
});
