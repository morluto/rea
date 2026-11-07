import {
  createGoBinaryFixture,
  createGoInlineAggregateFixture,
} from "./image.js";

/** Same framed content in modern inline and legacy pointer ELF64 records. */
export const goBuildInfoAdmissionFixture = (
  contentBytes: number,
  encoding: "inline" | "pointer" = "inline",
) => {
  const inline = createGoInlineAggregateFixture(contentBytes);
  if (encoding === "inline") return inline;
  const pointer = createGoBinaryFixture({
    encoding: "pointer",
    goVersion: "v",
    moduleText: "",
  });
  const bytes = Buffer.alloc(2304 + inline.moduleBytes.length);
  pointer.bytes.copy(bytes);
  inline.moduleBytes.copy(bytes, 2304);
  bytes.writeBigUInt64LE(BigInt(inline.moduleBytes.length), 1560);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 160);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 168);
  return { ...pointer, bytes, moduleBytes: inline.moduleBytes };
};
