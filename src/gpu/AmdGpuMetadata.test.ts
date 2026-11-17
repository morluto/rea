import { expect, it } from "vitest";
import { encode } from "@msgpack/msgpack";
import { readAmdMetadata } from "./AmdGpuMetadata.js";
import { GpuInventory } from "./GpuInventory.js";
import { GpuBufferSource } from "./GpuSource.js";
import { amdFixture } from "../../tests/fixtures/gpu/codeObjects.js";
it.each(["\uFEFFkernel", "\uFEFF" + "kernel".repeat(100)])(
  "preserves leading BOMs in MessagePack strings %s",
  (name) => {
    expect(readAmdMetadata(Buffer.from(encode({ name })))).toEqual({ name });
  },
);
it("preserves raw string tags separately from binary values", () => {
  const binary = Uint8Array.from([0x61, 0x62]);
  const read = readAmdMetadata(
    Buffer.from(encode({ text: "ab", binary })),
  ) as Record<string, unknown>;
  expect(read.text).toBe("ab");
  expect(read.binary).toBeInstanceOf(Uint8Array);
  expect(Array.from(read.binary as Uint8Array)).toEqual(Array.from(binary));
});
it("rejects duplicate map keys and malformed UTF-8 before semantic decoding", () => {
  expect(() => readAmdMetadata(Buffer.from("82a16101a16102", "hex"))).toThrow(
    /duplicate/u,
  );
  expect(() => readAmdMetadata(Buffer.from("81a161a1ff", "hex"))).toThrow(
    /UTF-8/u,
  );
});
it.each(["dd00010001", "df00010001", "ddffffffff"])(
  "rejects impossible MessagePack container extent before capacity: %s",
  (hex) => {
    expect(() => readAmdMetadata(Buffer.from(hex, "hex"))).toThrow(
      expect.objectContaining({ kind: "malformed" }),
    );
  },
);
it.each(["array", "map"] as const)(
  "distinguishes a full over-capacity %s from corruption",
  (kind) => {
    const container = (count: number) =>
      kind === "array"
        ? Array<number>(count).fill(0)
        : Object.fromEntries(
            Array.from({ length: count }, (_, index) => [`field${index}`, 0]),
          );
    const accepted = readAmdMetadata(Buffer.from(encode(container(65536))));
    expect(Object.keys(accepted as object)).toHaveLength(65536);
    expect(() =>
      readAmdMetadata(Buffer.from(encode(container(65537)))),
    ).toThrow(
      expect.objectContaining({
        name: "BinaryResourceFailure",
        maximum_bytes: 65536,
      }),
    );
  },
);
it("retains an earlier AMD note and kernel when a later note exceeds container capacity", async () => {
  const metadata = Buffer.from(
    encode({
      "amdhsa.kernels": [],
      "vendor.values": Array<number>(65537).fill(0),
    }),
  );
  const note = Buffer.alloc(20 + Math.ceil(metadata.length / 4) * 4);
  note.writeUInt32LE(7, 0);
  note.writeUInt32LE(metadata.length, 4);
  note.writeUInt32LE(32, 8);
  note.write("AMDGPU\0", 12);
  metadata.copy(note, 20);
  const inventory = new GpuInventory({ path: "/fixture", analysis: "kernels" });
  await inventory.inspect(new GpuBufferSource(amdFixture(false, note), null));
  expect(inventory.objects[0]).toMatchObject({
    inspection: "capacity",
    payload_target: "amdgcn-amd-amdhsa--gfx900",
    amd_target_metadata: {
      note_coverage: "partial",
      notes: [expect.any(Object)],
    },
  });
  expect(inventory.objects[0]!.limitations.join(" ")).toContain("65536");
  expect(inventory.kernels).toMatchObject([
    {
      name: "add_one",
      parameter_count: 2,
      parameter_bytes: 12,
      registers: { sgpr: 6, vgpr: 2 },
    },
  ]);
});
it("preserves long leading-BOM map keys through the public decoder extension point", () => {
  const key = "\uFEFF" + "field".repeat(60),
    object = { [key]: 123 };
  expect(readAmdMetadata(Buffer.from(encode(object)))).toEqual(object);
});
it("distinguishes an unsupported extension tag from a forbidden MessagePack token", () => {
  expect(() => readAmdMetadata(Buffer.from("d40000", "hex"))).toThrow(
    expect.objectContaining({ kind: "unsupported" }),
  );
  expect(() => readAmdMetadata(Buffer.from("c1", "hex"))).toThrow(
    expect.objectContaining({ kind: "malformed" }),
  );
});
