import { expect, it } from "vitest";
import { encode } from "@msgpack/msgpack";
import { gpuObjectSchema } from "../domain/gpu/gpuCodeObjects.js";
import { readAmdMetadata } from "./AmdGpuMetadata.js";
import { GpuInventory } from "./GpuInventory.js";
import { GpuBufferSource } from "./GpuSource.js";
import {
  amdAbiCodeObject,
  amdDescriptorNoteFixture,
  amdFixture,
  amdHsaMetadata,
  amdPalMetadata,
} from "../../tests/fixtures/gpu/codeObjects.js";
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
const nestedArrays = (depth: number): unknown =>
  Array.from({ length: depth }).reduce<unknown>((child) => [child], 0);

it("reports the measured nesting allowance for a small, deeply nested value", () => {
  const admitted = nestedArrays(32);
  expect(readAmdMetadata(Buffer.from(encode(admitted)))).toEqual(admitted);
  expect(() => readAmdMetadata(Buffer.from(encode(nestedArrays(33))))).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        limit: { name: "amdgpu-metadata-depth", maximum: 32 },
      }),
    }),
  );
});

it("reports the aggregate value allowance for shallow containers", () => {
  const values = Array<number>(65536).fill(0);
  expect(() =>
    readAmdMetadata(Buffer.from(encode([values, values, values, values]))),
  ).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        limit: { name: "amdgpu-metadata-values", maximum: 262144 },
      }),
    }),
  );
});

it("retains an earlier AMD note and kernel when a later note exceeds container capacity", async () => {
  const metadata = Buffer.from(
    encode({
      "amdhsa.kernels": [],
      "vendor.values": Array<number>(65537).fill(0),
    }),
  );
  const note = amdDescriptorNoteFixture(metadata);
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
const inspectAmd = async (
  bytes: Buffer,
  analysis: "inventory" | "kernels" = "kernels",
) => {
  const inventory = new GpuInventory({ path: "/fixture", analysis });
  await inventory.inspect(new GpuBufferSource(bytes, null));
  return inventory;
};

it("classifies HSA, PAL, and note-less PAL code objects from ELF OS ABI", async () => {
  const hsa = await inspectAmd(amdAbiCodeObject("hsa"));
  expect(hsa.discovery).toBe("complete");
  expect(hsa.objects[0]).toMatchObject({
    inspection: "complete",
    target: "amdgcn-amd-amdhsa--gfx1030",
    payload_target: "amdgcn-amd-amdhsa--gfx1030",
    limitations: [],
  });
  expect(hsa.kernels).toMatchObject([
    {
      name: "k0",
      symbol: "k0.kd",
      parameter_bytes: 8,
      shared_bytes: 0,
      private_bytes: 0,
      registers: { sgpr: 16, vgpr: 8, agpr: null },
    },
  ]);
  expect(hsa.objects[0]!.amd_target_metadata!.notes[0]).not.toHaveProperty(
    "pal_pipelines",
  );

  for (const analysis of ["inventory", "kernels"] as const) {
    const pal = await inspectAmd(amdAbiCodeObject("pal"), analysis);
    expect(pal.discovery).toBe("complete");
    expect(pal.kernels).toEqual([]);
    const row = gpuObjectSchema.parse(pal.objects[0]);
    expect(row).toMatchObject({
      inspection: analysis === "kernels" ? "complete" : "inventory",
      target: "gfx1030",
      payload_target: "gfx1030",
      target_consistency: "single-source",
      limitations: [],
      amd_target_metadata: {
        flags: "0x00000036",
        processor: "gfx1030",
        note_coverage: "complete",
        notes: [
          {
            target: null,
            target_state: "absent",
            pal_pipelines: [
              {
                api: "Vulkan",
                type: "VsPs",
                stages: [
                  {
                    name: ".vs",
                    entry_point: "_amdgpu_vs_main",
                    sgpr_count: 20,
                    vgpr_count: 12,
                    wavefront_size: 32,
                  },
                  {
                    name: ".ps",
                    entry_point: "_amdgpu_ps_main",
                    sgpr_count: 10,
                    vgpr_count: 6,
                    wavefront_size: 32,
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(row.amd_target_metadata!.notes[0]!.location).toMatchObject({
      section_name: ".note",
      size: Buffer.from(encode(amdPalMetadata())).length,
    });
  }

  const nometa = await inspectAmd(amdAbiCodeObject("nometa"));
  expect(nometa.discovery).toBe("partial");
  expect(nometa.kernels).toEqual([]);
  expect(nometa.objects[0]).toMatchObject({
    inspection: "unsupported",
    target: "gfx1030",
    payload_target: "gfx1030",
    limitations: ["No AMDGPU v3+ MessagePack kernel metadata was available"],
    amd_target_metadata: {
      flags: "0x00000036",
      processor: "gfx1030",
      note_coverage: "complete",
      notes: [],
    },
  });
});

it("selects the AMDGPU metadata schema from ELF OS ABI, not from note keys", async () => {
  const hsaAbiPalNote = await inspectAmd(
    amdAbiCodeObject("hsa", amdPalMetadata()),
  );
  expect(hsaAbiPalNote.kernels).toEqual([]);
  expect(hsaAbiPalNote.objects[0]).toMatchObject({
    inspection: "malformed",
    target: "gfx1030",
    limitations: ["AMDGPU metadata has no valid kernel array"],
  });
  expect(
    hsaAbiPalNote.objects[0]!.amd_target_metadata!.notes[0],
  ).not.toHaveProperty("pal_pipelines");

  const palAbiHsaNote = await inspectAmd(
    amdAbiCodeObject("pal", amdHsaMetadata()),
  );
  expect(palAbiHsaNote.discovery).toBe("partial");
  expect(palAbiHsaNote.kernels).toEqual([]);
  expect(palAbiHsaNote.objects[0]).toMatchObject({
    inspection: "unsupported",
    target: "amdgcn-amd-amdhsa--gfx1030",
    limitations: ["No AMDGPU v3+ MessagePack kernel metadata was available"],
  });

  const invalidPipelines = await inspectAmd(
    amdAbiCodeObject("pal", { "amdpal.pipelines": { ".vs": {} } }),
  );
  expect(invalidPipelines.kernels).toEqual([]);
  expect(invalidPipelines.objects[0]).toMatchObject({
    inspection: "malformed",
    target: "gfx1030",
    limitations: ["AMDGPU PAL metadata has no valid pipeline array"],
  });
});

it("keeps decoded PAL stages when a sibling stage or pipeline is not a map", async () => {
  const pal = structuredClone(amdPalMetadata()) as {
    "amdpal.pipelines": unknown[];
  };
  const stages = (pal["amdpal.pipelines"][0] as Record<string, unknown>)[
    ".hardware_stages"
  ] as Record<string, unknown>;
  stages[".ps"] = null;
  pal["amdpal.pipelines"].push({ ".api": 1, ".type": "Cs" }, null);
  const inventory = await inspectAmd(amdAbiCodeObject("pal", pal));
  expect(inventory.discovery).toBe("partial");
  expect(inventory.kernels).toEqual([]);
  const row = gpuObjectSchema.parse(inventory.objects[0]);
  expect(row).toMatchObject({
    inspection: "partial",
    target: "gfx1030",
    limitations: [
      "AMDGPU PAL hardware stage metadata is not a map; stage fields remain unknown",
      "AMDGPU PAL pipeline metadata is not a map; pipeline fields remain unknown",
    ],
    amd_target_metadata: {
      note_coverage: "partial",
      notes: [
        {
          pal_pipelines: [
            {
              api: "Vulkan",
              type: "VsPs",
              stages: [
                {
                  name: ".vs",
                  entry_point: "_amdgpu_vs_main",
                  sgpr_count: 20,
                  vgpr_count: 12,
                  wavefront_size: 32,
                },
                {
                  name: ".ps",
                  entry_point: null,
                  sgpr_count: null,
                  vgpr_count: null,
                  wavefront_size: null,
                },
              ],
            },
            { api: null, type: "Cs", stages: null },
            { api: null, type: null, stages: null },
          ],
        },
      ],
    },
  });
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
