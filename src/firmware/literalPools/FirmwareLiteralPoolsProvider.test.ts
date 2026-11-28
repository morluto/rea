import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import * as scannerModule from "../../domain/firmware/firmwareLiteralPoolScanner.js";
import { FirmwareLiteralPoolsProvider } from "./FirmwareLiteralPoolsProvider.js";

const DEFAULTS = {
  scan_offset: 0,
  max_scan_bytes: 1024 * 1024,
  max_references: 16_384,
  max_representation_bytes: 16 * 1024 * 1024,
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
    if (cancelledBefore.ok) throw new Error("expected pre-scan cancellation");
    expect(cancelledBefore.error._tag).toBe("AnalysisCancelledError");
    expect(cancelledBefore.error.cause).toBe(preReason);

    const midAbort = new AbortController();
    const midReason = new Error("caller-cancelled-mid-scan");
    const realSteps = scannerModule.scanFirmwareLiteralPoolsSteps;
    const scanSpy = vi
      .spyOn(scannerModule, "scanFirmwareLiteralPoolsSteps")
      .mockImplementationOnce(function* (opts) {
        const inner = realSteps(opts);
        let next = inner.next();
        expect(next.done).toBe(false);
        if (!next.done) {
          midAbort.abort(midReason);
          yield next.value;
          next = inner.next();
        }
        while (!next.done) {
          yield next.value;
          next = inner.next();
        }
        return next.value;
      });
    const cancelledMid = await provider.inspect(
      {
        ...DEFAULTS,
        path: fwPath,
        isa: "arm-thumb",
        base_address: "0x08000000",
      },
      { signal: midAbort.signal },
    );
    scanSpy.mockRestore();
    expect(cancelledMid.ok).toBe(false);
    if (cancelledMid.ok) throw new Error("expected mid-scan cancellation");
    expect(cancelledMid.error._tag).toBe("AnalysisCancelledError");
    expect(cancelledMid.error.cause).toBe(midReason);

    const badAlign = await provider.inspect({
      ...DEFAULTS,
      path: fwPath,
      isa: "arm-thumb",
      base_address: "0x08000001",
    });
    expect(badAlign.ok).toBe(false);
    if (badAlign.ok) throw new Error("expected alignment error");
    expect(badAlign.error._tag).toBe("AnalysisInputError");

    const badSvd = await provider.inspect({
      ...DEFAULTS,
      path: fwPath,
      isa: "arm-thumb",
      base_address: "0x08000000",
      svd_xml: "<notDevice/>",
    });
    expect(badSvd.ok).toBe(false);
    if (badSvd.ok) throw new Error("expected SVD format error");
    expect(badSvd.error._tag).toBe("AnalysisInputError");

    const baseBlocks = Array.from(
      { length: 20 },
      (_, idx) =>
        `<addressBlock><offset>0x${(idx * 16).toString(16)}</offset><size>0x4</size><usage>registers</usage></addressBlock>`,
    ).join("");
    const derivedClones = Array.from(
      { length: 20 },
      (_, idx) =>
        `<peripheral derivedFrom="BASE_P"><name>P${String(idx)}</name><baseAddress>0x${(0x4000_0000 + (idx + 1) * 0x1000).toString(16)}</baseAddress></peripheral>`,
    ).join("");
    const svdLimitRes = await provider.inspect({
      ...DEFAULTS,
      path: fwPath,
      isa: "arm-thumb",
      base_address: "0x08000000",
      svd_xml: `<device><peripherals><peripheral><name>BASE_P</name><baseAddress>0x40000000</baseAddress>${baseBlocks}</peripheral>${derivedClones}</peripherals></device>`,
      max_svd_nodes: 300,
    });
    expect(svdLimitRes.ok).toBe(false);
    if (svdLimitRes.ok) throw new Error("expected SVD expansion limit");
    expect(svdLimitRes.error._tag).toBe("AnalysisResourceConstraintError");
    expect(svdLimitRes.error.limit).toMatchObject({
      control_kind: "parameter",
      parameter: "max_svd_nodes",
      effective_value: 300,
      required_value: 21 * 20,
    });

    const fileLimitRes = await provider.inspect({
      ...DEFAULTS,
      path: fwPath,
      isa: "arm-thumb",
      base_address: "0x08000000",
      max_file_bytes: 64,
    });
    expect(fileLimitRes.ok).toBe(false);
    if (fileLimitRes.ok) throw new Error("expected file size limit");
    expect(fileLimitRes.error._tag).toBe("AnalysisResourceConstraintError");
    expect(fileLimitRes.error.limit).toMatchObject({
      control_kind: "parameter",
      parameter: "max_file_bytes",
      effective_value: 64,
      required_value: image.length,
    });

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
    if (refLimitRes.ok) throw new Error("expected max_references limit");
    expect(refLimitRes.error._tag).toBe("AnalysisResourceConstraintError");
    expect(refLimitRes.error.limit).toMatchObject({
      control_kind: "parameter",
      parameter: "max_references",
      effective_value: 1,
      required_value: 2,
    });

    const longName = "P".repeat(2048);
    const repLoads = Buffer.alloc(32, 0x00);
    repLoads.writeUInt16LE(0x4803, 0x00);
    repLoads.writeUInt16LE(0x4903, 0x02);
    repLoads.writeUInt16LE(0x4a02, 0x04);
    repLoads.writeUInt16LE(0x4b02, 0x06);
    repLoads.writeUInt32LE(0x4000_0000, 0x10);
    const repLoadsPath = join(dir, "rep_loads.bin");
    await writeFile(repLoadsPath, repLoads);
    const repLimitRes = await provider.inspect({
      ...DEFAULTS,
      path: repLoadsPath,
      isa: "arm-thumb",
      base_address: "0x08000000",
      svd_xml: `<device><peripherals><peripheral><name>${longName}</name><baseAddress>0x40000000</baseAddress><addressBlock><offset>0x0</offset><size>0x10</size><usage>registers</usage></addressBlock></peripheral></peripherals></device>`,
      max_representation_bytes: 4096,
    });
    expect(repLimitRes.ok).toBe(false);
    if (repLimitRes.ok) throw new Error("expected representation byte limit");
    expect(repLimitRes.error._tag).toBe("AnalysisResourceConstraintError");
    expect(repLimitRes.error.limit).toMatchObject({
      control_kind: "parameter",
      parameter: "max_representation_bytes",
      effective_value: 4096,
      required_value: expect.any(Number),
    });
    const repLimit = repLimitRes.error.limit;
    if (
      repLimit === undefined ||
      !("required_value" in repLimit) ||
      typeof repLimit.required_value !== "number"
    ) {
      throw new Error("expected parameter limit with numeric required_value");
    }
    expect(repLimit.required_value).toBeGreaterThan(4 * 2048);

    await provider.close();
  });
});
