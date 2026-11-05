import { expect, it } from "vitest";
import { buildAnp3 } from "../../tests/fixtures/imgAnp3.js";
import { hasAnp3Header, parseAnp3Package } from "./anp3AnimationFormat.js";

it("reports objects, bones and the latest final keyframe time for every frame type", () => {
  const bytes = buildAnp3(
    "actor",
    [
      {
        name: "walk_civi",
        objects: [
          { bone: "Root", boneId: 0, frameType: 4, times: [0, 0.5, 1.25] },
          { bone: "Pelvis", boneId: 1, frameType: 3, times: [0, 1] },
        ],
      },
      {
        name: "idle",
        objects: [
          { bone: "Root", boneId: 0, frameType: 2, times: [0, 2.5] },
          { bone: "Head", boneId: 5, frameType: 1, times: [0.25] },
        ],
      },
      { name: "empty", objects: [] },
    ],
    2048,
  );
  expect(hasAnp3Header(bytes)).toBe(true);
  const parsed = parseAnp3Package(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  expect(parsed.value.packageName).toBe("actor");
  expect(parsed.value.trailingBytes).toBe(2048);
  const [walk, idle, empty] = parsed.value.animations;
  expect(walk).toMatchObject({
    index: 0,
    name: "walk_civi",
    byteOffset: 36,
    byteLength: 36 + 36 + 3 * 16 + 36 + 2 * 10,
    keyframeCount: 5,
    durationSeconds: 1.25,
    flags: 1,
    bones: [
      { name: "Root", bone_id: 0, frame_type: 4, frame_count: 3 },
      { name: "Pelvis", bone_id: 1, frame_type: 3, frame_count: 2 },
    ],
  });
  expect(idle).toMatchObject({
    byteOffset: walk!.byteOffset + walk!.byteLength,
    byteLength: 36 + 36 + 2 * 32 + 36 + 20,
    durationSeconds: 2.5,
  });
  expect(empty).toMatchObject({
    keyframeCount: 0,
    durationSeconds: null,
    bones: [],
  });
});

it("keeps a non-finite final time unknown instead of inventing a duration", () => {
  const bytes = buildAnp3("actor", [
    {
      name: "broken",
      objects: [{ bone: "Root", boneId: 0, frameType: 1, times: [0, 1] }],
    },
  ]);
  bytes.writeFloatLE(Number.NaN, bytes.length - 4);
  const parsed = parseAnp3Package(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  expect(parsed.value.animations[0]).toMatchObject({
    keyframeCount: 2,
    durationSeconds: null,
  });
});

it.each([
  {
    label: "a missing signature",
    modify: (bytes: Buffer) => bytes.write("ANPK", 0, "latin1"),
    reason: "missing ANP3",
  },
  {
    label: "an animation count beyond the file",
    modify: (bytes: Buffer) => bytes.writeUInt32LE(1_000, 32),
    reason: "cannot fit",
  },
  {
    label: "an unknown frame type",
    modify: (bytes: Buffer) => bytes.writeUInt32LE(7, 36 + 36 + 24),
    reason: "unknown frame type 7",
  },
  {
    label: "keyframes beyond the file",
    modify: (bytes: Buffer) => bytes.writeUInt32LE(99, 36 + 36 + 28),
    reason: "99 keyframes beyond the file",
  },
])("refuses $label", ({ modify, reason }) => {
  const bytes = buildAnp3("actor", [
    {
      name: "walk",
      objects: [{ bone: "Root", boneId: 0, frameType: 3, times: [0] }],
    },
  ]);
  modify(bytes);
  expect(parseAnp3Package(bytes)).toEqual({
    ok: false,
    error: expect.stringContaining(reason),
  });
});

it("refuses a truncated header", () => {
  expect(parseAnp3Package(Buffer.from("ANP3\0\0\0\0"))).toEqual({
    ok: false,
    error: expect.stringContaining("truncated header"),
  });
});
