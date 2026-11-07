import { describe, expect, it } from "vitest";
import { FunctionByteCoverage } from "./functionByteCoverage.js";
import { functionBodySchema } from "./functionBody.js";
import { nativeByteReadSchema } from "./nativeByteRead.js";

const read = (address: string, hex: string) =>
  nativeByteReadSchema.parse({
    address,
    requested_bytes: hex.length / 2,
    returned_bytes: hex.length / 2,
    bytes_hex: hex,
    complete: true,
  });

const body = functionBodySchema.parse({
  available: true,
  provenance: "test",
  span_bytes: 4,
  non_contiguous: false,
  total_bytes: 4,
  contains_entry: true,
  ranges: [{ start: "0x1000", end: "0x1003" }],
});

describe("FunctionByteCoverage", () => {
  it("retains every Evidence link for identical overlapping reads", async () => {
    const coverage = new FunctionByteCoverage(async () => undefined);
    await coverage.add(read("0x1000", "01020304"), "ev_a");
    await coverage.add(read("0x1000", "01020304"), "ev_b");

    await expect(coverage.fingerprint(body)).resolves.toMatchObject({
      links: ["ev_a", "ev_b"],
    });
  });
});
