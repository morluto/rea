import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { gpuObjectSchema, gpuPtxArtifactSchema } from "./gpuCodeObjects.js";
it("binds retained PTX identity to its actual UTF-8 bytes and source extent", () => {
  const text = "\uFEFF// 雪🧪\n.version 8.8\n",
    size = Buffer.byteLength(text);
  const artifact = {
    id: "ptx",
    object_id: "object",
    sha256: createHash("sha256").update(text).digest("hex"),
    media_type: "text/x-ptx",
    encoding: "utf-8",
    byte_length: size,
    text,
    location: {
      container_id: "object",
      offset: 0,
      size,
      section_index: null,
      section_name: null,
    },
  };
  expect(gpuPtxArtifactSchema.safeParse(artifact).success).toBe(true);
  for (const patch of [
    { sha256: "0".repeat(64) },
    { text: text + "changed" },
    { byte_length: size + 1 },
    { location: { ...artifact.location, size: size + 1 } },
    { text: "\ud800" },
  ])
    expect(
      gpuPtxArtifactSchema.safeParse({ ...artifact, ...patch }).success,
    ).toBe(false);
});

it("requires the AMD target metadata fact that every inventory row records", () => {
  const field = gpuObjectSchema.shape.amd_target_metadata;
  expect(field.safeParse(null).success).toBe(true);
  expect(field.safeParse(undefined).success).toBe(false);
});

it("keeps AMD notes valid when PAL pipelines are omitted or declared", () => {
  const field = gpuObjectSchema.shape.amd_target_metadata;
  const location = {
    container_id: "object",
    offset: 0,
    size: 64,
    section_index: null,
    section_name: null,
  };
  const note = {
    target: null,
    target_state: "absent" as const,
    location: { ...location, section_index: 1, section_name: ".note", size: 8 },
  };
  const metadata = {
    flags: "0x00000036",
    processor: "gfx1030",
    header_location: location,
    note_coverage: "complete" as const,
    notes: [note],
  };
  expect(field.safeParse(metadata).success).toBe(true);
  expect(
    field.safeParse({
      ...metadata,
      notes: [
        {
          ...note,
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
              ],
            },
          ],
        },
      ],
    }).success,
  ).toBe(true);
  expect(
    field.safeParse({
      ...metadata,
      notes: [{ ...note, pal_pipelines: [{ api: 1 }] }],
    }).success,
  ).toBe(false);
});
