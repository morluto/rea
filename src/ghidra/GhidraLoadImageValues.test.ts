import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { attestGhidraDosLoadImage } from "./GhidraLoadImageValues.js";
import { fixtureDosLoadImage } from "./GhidraLoadImage.fixture.js";
import { nativeLoadImageObservationSchema } from "../domain/native/nativeLoadImage.js";
import type { NativeLoadImageObservation } from "../domain/native/nativeLoadImage.js";

const damage: ReadonlyArray<
  readonly [string, (observation: NativeLoadImageObservation) => void]
> = [
  [
    "memory byte",
    (x) => {
      if (x.mappings[1]) x.mappings[1].sha256 = "f".repeat(64);
    },
  ],
  [
    "header byte",
    (x) => {
      if (x.mappings[0]) x.mappings[0].sha256 = "f".repeat(64);
    },
  ],
  [
    "modified source",
    (x) => {
      x.source_files[0] && (x.source_files[0].modified_sha256 = "f".repeat(64));
    },
  ],
  [
    "original source",
    (x) => {
      x.source_files[0] && (x.source_files[0].original_sha256 = "f".repeat(64));
    },
  ],
  [
    "source length",
    (x) => {
      if (x.source_files[0]) x.source_files[0].size--;
    },
  ],
  [
    "source identity",
    (x) => {
      if (x.mappings[1]) x.mappings[1].source_file_index = 1;
    },
  ],
  [
    "missing mapping",
    (x) => {
      x.mappings.splice(1, 1);
    },
  ],
  [
    "duplicate mapping",
    (x) => {
      if (x.mappings[1]) x.mappings.push(structuredClone(x.mappings[1]));
    },
  ],
  [
    "gap",
    (x) => {
      if (x.mappings[1]) x.mappings[1].file_offset = 33;
    },
  ],
  [
    "overlap",
    (x) => {
      if (x.mappings[1]) x.mappings[1].file_offset = 31;
    },
  ],
  [
    "alias address",
    (x) => {
      if (x.mappings[1]) x.mappings[1].start = "0x10001";
    },
  ],
  [
    "end address",
    (x) => {
      if (x.mappings[1]) x.mappings[1].end = "0x10080";
    },
  ],
  [
    "wrong address space",
    (x) => {
      x.default_address_space = "wrong";
    },
  ],
  [
    "header loaded",
    (x) => {
      if (x.mappings[0]) x.mappings[0].loaded = true;
    },
  ],
  [
    "module overlay",
    (x) => {
      if (x.mappings[1]) x.mappings[1].overlay = true;
    },
  ],
  [
    "uninitialized module",
    (x) => {
      if (x.mappings[1]) x.mappings[1].initialized = false;
    },
  ],
  [
    "complex source mapping",
    (x) => {
      if (x.mappings[1]) x.mappings[1].file_offset = null;
    },
  ],
  [
    "missing relocation",
    (x) => {
      x.relocations = [];
    },
  ],
  [
    "duplicate relocation",
    (x) => {
      if (x.relocations[0])
        x.relocations.push(structuredClone(x.relocations[0]));
    },
  ],
  [
    "relocation word",
    (x) => {
      if (x.relocations[0]) x.relocations[0].memory_bytes_hex = "0400";
    },
  ],
  [
    "relocation metadata",
    (x) => {
      if (x.relocations[0]) x.relocations[0].values = [0, 9, 4];
    },
  ],
  [
    "relocation status",
    (x) => {
      if (x.relocations[0]) x.relocations[0].status = "FAILURE";
    },
  ],
  [
    "relocation segment",
    (x) => {
      if (x.relocations[0]) x.relocations[0].segment = 0;
    },
  ],
  [
    "entry",
    (x) => {
      x.entry_points = ["0x10001"];
    },
  ],
  [
    "extra entry",
    (x) => {
      x.entry_points.push("0x10010");
    },
  ],
  [
    "loader",
    (x) => {
      x.executable_format = "Raw Binary";
    },
  ],
  [
    "language",
    (x) => {
      x.language_id = "x86:LE:32:default";
    },
  ],
  [
    "compiler",
    (x) => {
      x.compiler_spec_id = "windows";
    },
  ],
  [
    "image base",
    (x) => {
      x.image_base = "0x10000";
    },
  ],
  [
    "extra source file",
    (x) => {
      if (x.source_files[0])
        x.source_files.push(structuredClone(x.source_files[0]));
    },
  ],
  [
    "initialized unbacked alias",
    (x) => {
      if (x.mappings[2]) x.mappings[2].initialized = true;
    },
  ],
  [
    "overlay source mapping",
    (x) => {
      const row = x.mappings[1];
      if (row)
        x.mappings.push({
          ...row,
          file_offset: 160,
          length: 23,
          start: "0x10080",
          end: "0x10096",
        });
    },
  ],
];
describe("independent DOS MZ import verification", () => {
  it("verifies every initialized source byte while retaining overlay and BSS scope", () => {
    const fixture = fixtureDosLoadImage();
    const result = attestGhidraDosLoadImage(
      fixture.bytes,
      fixture.sha256,
      fixture.observation,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "verified",
        module_bytes: 128,
        header_bytes: 32,
        overlay_bytes: 23,
        entry: { linear_address: "0x10000" },
      },
    });
    if (!result.ok || result.value.status === "unsupported")
      throw new Error("Expected measured MZ checks");
    expect(result.value.checks.every((check) => check.matched)).toBe(true);
    expect(result.value.observations).toEqual(fixture.observation);
    expect(result.value.limitations.join(" ")).toMatch(
      /runtime behavior.*not verified/u,
    );
  });

  it.each(damage)(
    "rejects a %s despite a matching executable digest",
    (_name, mutate) => {
      const fixture = fixtureDosLoadImage();
      mutate(fixture.observation);
      const result = attestGhidraDosLoadImage(
        fixture.bytes,
        fixture.sha256,
        fixture.observation,
      );
      expect(result).toMatchObject({
        ok: true,
        value: { status: "mismatch", observations: fixture.observation },
      });
      if (!result.ok || result.value.status === "unsupported")
        throw new Error("Expected MZ verification checks");
      expect(result.value.checks.some((check) => !check.matched)).toBe(true);
    },
  );

  it("retains source range coordinates when memory evidence disagrees", () => {
    const fixture = fixtureDosLoadImage();
    const mapping = fixture.observation.mappings[1];
    if (mapping === undefined) throw new Error("Missing module mapping");
    mapping.sha256 = "f".repeat(64);
    const result = attestGhidraDosLoadImage(
      fixture.bytes,
      fixture.sha256,
      fixture.observation,
    );
    if (!result.ok || result.value.status === "unsupported")
      throw new Error("Expected MZ verification checks");
    expect(result.value.checks.filter((check) => !check.matched)).toEqual([
      expect.objectContaining({
        name: "mapping[1].memory_sha256",
        file_offset: 32,
        address: "0x10000",
        observed: "f".repeat(64),
      }),
    ]);
  });

  it("is independent of mapping iteration order", () => {
    const fixture = fixtureDosLoadImage();
    fixture.observation.mappings.reverse();
    expect(
      attestGhidraDosLoadImage(
        fixture.bytes,
        fixture.sha256,
        fixture.observation,
      ),
    ).toMatchObject({ ok: true, value: { status: "verified" } });
  });

  it("accepts a different segment alias while preserving the observed coordinates and raw table values", () => {
    const fixture = fixtureDosLoadImage();
    const relocation = fixture.observation.relocations[0];
    if (relocation === undefined)
      throw new Error("Missing source-owned relocation");
    relocation.segment = 0x0fff;
    relocation.offset = 25;
    expect(
      attestGhidraDosLoadImage(
        fixture.bytes,
        fixture.sha256,
        fixture.observation,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        status: "verified",
        observations: {
          relocations: [
            { segment: 0x0fff, offset: 25, values: [0, 9, 0x1004] },
          ],
        },
      },
    });
  });

  it("rejects a changed snapshot and malformed MZ rather than trusting provider hashes", () => {
    const fixture = fixtureDosLoadImage();
    fixture.bytes[0] = 0;
    expect(
      attestGhidraDosLoadImage(
        fixture.bytes,
        fixture.sha256,
        fixture.observation,
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("digest") });
    const digest = createHash("sha256").update(fixture.bytes).digest("hex");
    expect(
      attestGhidraDosLoadImage(fixture.bytes, digest, fixture.observation),
    ).toMatchObject({ ok: false, error: expect.stringContaining("MZ header") });
  });

  it("rejects malformed producer digests and unsafe source coordinates", () => {
    const fixture = fixtureDosLoadImage();
    expect(
      nativeLoadImageObservationSchema.safeParse({
        ...fixture.observation,
        source_files: [
          { ...fixture.observation.source_files[0], original_sha256: "bad" },
        ],
      }).success,
    ).toBe(false);
    const mapping = fixture.observation.mappings[0];
    expect(
      nativeLoadImageObservationSchema.safeParse({
        ...fixture.observation,
        mappings: [{ ...mapping, file_offset: Number.MAX_SAFE_INTEGER + 1 }],
      }).success,
    ).toBe(false);
  });
});
