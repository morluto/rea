import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { cortexM0Fixture } from "../../tests/conformance/ghidra/cortexM.fixture.mjs";
import { attestGhidraRawBinaryLoadImage } from "./GhidraLoadImageValues.js";
import { fixtureRawBinaryLoadImage } from "./GhidraRawBinaryLoadImage.fixture.js";
import {
  GHIDRA_RAW_ENTRY_CONTEXT,
  GHIDRA_VARIANT_LANGUAGES,
  GHIDRA_VARIANT_LIMITATIONS,
  ghidraRawBinaryLanguage,
  ghidraRawBinaryLimitations,
} from "./GhidraRawBinaryLanguage.js";
import {
  ARCHITECTURE_VARIANT_NAMES,
  ARCHITECTURE_VARIANTS,
} from "../domain/architectureVariant.js";
import type { RawBinaryLoad } from "../domain/binaryTargetTypes.js";
import {
  admittedRawLoad,
  rawLoadAtEntry,
} from "../domain/rawBinary.fixture.js";

describe("raw-binary Ghidra language binding", () => {
  it("maps the big-endian m68k family to the default 68000 language", () => {
    expect(ghidraRawBinaryLanguage("m68k")).toEqual({
      languageId: "68000:BE:32:default",
      compilerSpecId: "default",
      defaultAddressSpace: "ram",
    });
  });
  it("maps the four admitted families to little-endian generic languages", () => {
    expect(ghidraRawBinaryLanguage("x86")).toEqual({
      languageId: "x86:LE:32:default",
      compilerSpecId: "gcc",
      defaultAddressSpace: "ram",
    });
    expect(ghidraRawBinaryLanguage("x86_64")).toEqual({
      languageId: "x86:LE:64:default",
      compilerSpecId: "gcc",
      defaultAddressSpace: "ram",
    });
    expect(ghidraRawBinaryLanguage("arm")).toEqual({
      languageId: "ARM:LE:32:v7",
      compilerSpecId: "default",
      defaultAddressSpace: "ram",
    });
    expect(ghidraRawBinaryLanguage("arm64")).toEqual({
      languageId: "AARCH64:LE:64:v8A",
      compilerSpecId: "default",
      defaultAddressSpace: "ram",
    });
  });
});

describe("raw-binary variant Ghidra binding", () => {
  it.each(ARCHITECTURE_VARIANT_NAMES)(
    "binds %s to its little-endian ARM decoder and Thumb entry context",
    (variant) => {
      const row = ARCHITECTURE_VARIANTS[variant];
      expect(ghidraRawBinaryLanguage(row.architecture, variant)).toEqual({
        languageId: GHIDRA_VARIANT_LANGUAGES[variant],
        compilerSpecId: "default",
        defaultAddressSpace: "ram",
      });
      expect(GHIDRA_VARIANT_LANGUAGES[variant]).toMatch(/^ARM:LE:32:/u);
      expect(GHIDRA_RAW_ENTRY_CONTEXT[row.isaMode]).toMatchObject({
        register: "TMode",
        value: "0x1",
      });
    },
  );
  it("keeps the generic ARM decoder when no variant is named", () => {
    expect(ghidraRawBinaryLanguage("arm").languageId).toBe("ARM:LE:32:v7");
  });
  // Observed on real Ghidra 12.1.4; verify:ghidra:cortex-m checks it.
  it.each(ARCHITECTURE_VARIANT_NAMES)(
    "reports Ghidra's low-overhead-loop flow only for armv8.1-m.main: %s",
    (variant) => {
      const loopFlow = (text: string) => text.includes("low-overhead-loop");
      // Every lane that loads the variant reads this table.
      expect(GHIDRA_VARIANT_LIMITATIONS[variant].some(loopFlow)).toBe(
        variant === "armv8.1-m.main",
      );
      const limitations = ghidraRawBinaryLimitations(
        admittedRawLoad({
          architecture: "arm",
          architectureVariant: variant,
          baseAddress: "0x8000000",
          entryPoint: "0x8000000",
          fileBytes: 4,
        }),
        ghidraRawBinaryLanguage("arm", variant),
      );
      expect(limitations).toEqual(
        expect.arrayContaining([...GHIDRA_VARIANT_LIMITATIONS[variant]]),
      );
      expect(limitations.some(loopFlow)).toBe(variant === "armv8.1-m.main");
    },
  );
});

describe("raw-binary mapped-block state", () => {
  it.each(["RAM", "ram"])(
    "requires the bound 6502 address space for %s observations",
    (space) => {
      const f = fixtureRawBinaryLoadImage();
      const target = {
        ...f.target,
        architecture: "6502" as const,
        availableArchitectures: ["6502" as const],
        rawLoad: rawLoadAtEntry("0x8001"),
      };
      f.observation.language_id = "6502:LE:16:default";
      f.observation.default_address_space = space;
      f.observation.entry_points = [target.rawLoad.entryPoint];
      const mapping = f.observation.mappings[0];
      if (mapping === undefined)
        throw new Error("Missing source mapping fixture");
      mapping.start = target.rawLoad.baseAddress;
      mapping.end = "0x8004";
      mapping.address_space = space;
      expect(
        attestGhidraRawBinaryLoadImage(f.snapshot, target, f.observation),
      ).toMatchObject({
        ok: true,
        value: {
          status: space === "RAM" ? "verified" : "mismatch",
          checks: expect.arrayContaining([
            expect.objectContaining({
              name: "default_address_space",
              expected: "RAM",
              observed: space,
              matched: space === "RAM",
            }),
          ]),
        },
      });
    },
  );
  it.each(["ram", "RAM"])(
    "requires the bound m68k address space for %s observations",
    (space) => {
      const f = fixtureRawBinaryLoadImage();
      const target = {
        ...f.target,
        architecture: "m68k" as const,
        availableArchitectures: ["m68k" as const],
        rawLoad: rawLoadAtEntry("0x1000"),
      };
      f.observation.language_id = "68000:BE:32:default";
      f.observation.default_address_space = space;
      f.observation.entry_points = [target.rawLoad.entryPoint];
      const mapping = f.observation.mappings[0];
      if (mapping === undefined)
        throw new Error("Missing source mapping fixture");
      mapping.start = target.rawLoad.baseAddress;
      mapping.end = "0x1003";
      mapping.address_space = space;
      expect(
        attestGhidraRawBinaryLoadImage(f.snapshot, target, f.observation),
      ).toMatchObject({
        ok: true,
        value: {
          status: space === "ram" ? "verified" : "mismatch",
          language_id: "68000:BE:32:default",
          checks: expect.arrayContaining([
            expect.objectContaining({
              name: "default_address_space",
              expected: "ram",
              observed: space,
              matched: space === "ram",
            }),
          ]),
        },
      });
    },
  );
  it.each([
    ["initialized", false],
    ["loaded", false],
    ["overlay", true],
    ["address_space", "overlay"],
  ] as const)(
    "retains a mismatch when the file mapping declares %s=%s",
    (property, value) => {
      const f = fixtureRawBinaryLoadImage();
      const mapping = f.observation.mappings[0];
      if (mapping === undefined)
        throw new Error("Missing source mapping fixture");
      Object.assign(mapping, { [property]: value });
      expect(
        attestGhidraRawBinaryLoadImage(f.snapshot, f.target, f.observation),
      ).toMatchObject({
        ok: true,
        value: {
          status: "mismatch",
          observations: f.observation,
          checks: expect.arrayContaining([
            expect.objectContaining({
              name: `mapping.${property}`,
              matched: false,
              observed: value,
            }),
          ]),
        },
      });
    },
  );
  it("does not verify a foreign default address space even when its mapping agrees", () => {
    const f = fixtureRawBinaryLoadImage();
    f.observation.default_address_space = "foreign";
    const mapping = f.observation.mappings[0];
    if (mapping === undefined)
      throw new Error("Missing source mapping fixture");
    mapping.address_space = "foreign";
    expect(
      attestGhidraRawBinaryLoadImage(f.snapshot, f.target, f.observation),
    ).toMatchObject({
      ok: true,
      value: {
        status: "mismatch",
        observations: f.observation,
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: "default_address_space",
            matched: false,
            observed: "foreign",
          }),
        ]),
      },
    });
  });
});

describe("raw-binary independent load-image checks", () => {
  it("retains uninitialized language memory without treating it as file-backed bytes", () => {
    const f = fixtureRawBinaryLoadImage();
    const zeroPage = {
      block: "ZERO_PAGE",
      start: "0x0",
      end: "0xff",
      address_space: "ram",
      initialized: false,
      loaded: true,
      overlay: false,
      readable: true,
      writable: true,
      executable: false,
      length: 256,
      source_file_index: null,
      file_offset: null,
      sha256: null,
    };
    f.observation.mappings.unshift(zeroPage);
    expect(
      attestGhidraRawBinaryLoadImage(f.snapshot, f.target, f.observation),
    ).toMatchObject({
      ok: true,
      value: { status: "verified", observations: f.observation },
    });
    zeroPage.initialized = true;
    expect(
      attestGhidraRawBinaryLoadImage(f.snapshot, f.target, f.observation),
    ).toMatchObject({
      ok: true,
      value: {
        status: "mismatch",
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: "initialized_unbacked_mappings",
            matched: false,
          }),
        ]),
      },
    });
  });
  it("verifies mapped bytes at the caller-supplied entry", () => {
    const f = fixtureRawBinaryLoadImage();
    const result = attestGhidraRawBinaryLoadImage(
      f.snapshot,
      f.target,
      f.observation,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "verified",
        format: "raw-binary",
        architecture: "arm",
        language_id: "ARM:LE:32:v7",
        base_address: "0x8000000",
        file_bytes: 4,
        entry: { address: "0x8000000", file_offset: 0 },
      },
    });
  });
  it("keeps the complete load image of a load based at its caller entry", () => {
    const f = fixtureRawBinaryLoadImage();
    const result = attestGhidraRawBinaryLoadImage(
      f.snapshot,
      f.target,
      f.observation,
    );
    if (!result.ok) throw new Error(result.error);
    // Pinned at d6f88becd: saved raw-binary Evidence keeps this exact shape.
    expect(
      createHash("sha256").update(JSON.stringify(result.value)).digest("hex"),
    ).toBe("22e87550552b7d26eb5547161f6d7b815ceab8e158642058ee4796bc3848f948");
  });
  it("retains mismatch evidence for a drifted language", () => {
    const f = fixtureRawBinaryLoadImage();
    f.observation.language_id = "x86:LE:32:default";
    const result = attestGhidraRawBinaryLoadImage(
      f.snapshot,
      f.target,
      f.observation,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { status: "mismatch", observations: f.observation },
    });
  });
  it("preserves additional language entries while requiring the caller entry", () => {
    const f = fixtureRawBinaryLoadImage();
    f.observation.entry_points = [
      "0x0",
      f.target.rawLoad.entryPoint,
      "0xffff0000",
    ];
    expect(
      attestGhidraRawBinaryLoadImage(f.snapshot, f.target, f.observation),
    ).toMatchObject({
      ok: true,
      value: { status: "verified", observations: f.observation },
    });
    f.observation.entry_points = ["0x0", "0xffff0000"];
    expect(
      attestGhidraRawBinaryLoadImage(f.snapshot, f.target, f.observation),
    ).toMatchObject({
      ok: true,
      value: {
        status: "mismatch",
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: "entry_point",
            matched: false,
            observed: null,
          }),
        ]),
      },
    });
  });
  it("rejects stale snapshot identity", () => {
    const f = fixtureRawBinaryLoadImage();
    expect(
      attestGhidraRawBinaryLoadImage(
        f.snapshot,
        { ...f.target, sha256: "f".repeat(64) },
        f.observation,
      ).ok,
    ).toBe(false);
  });
});

// One Cortex-M0 image holds the vector table and the Thumb code its Reset
// word names; every load below is admitted from these bytes.
const m0Image = cortexM0Fixture(0x08000000);
const thumbImage = (rawLoad: RawBinaryLoad, tmode: string | null = "0x1") => {
  const f = fixtureRawBinaryLoadImage(m0Image, rawLoad);
  f.observation.entry_context = [
    {
      address: rawLoad.entryPoint,
      registers: [{ name: "TMode", value_hex: tmode }],
    },
  ];
  return f;
};
const resetLoad = admittedRawLoad(
  {
    architecture: "arm",
    architectureVariant: "armv8-m.main",
    entryPoint: undefined,
    baseAddress: "0x08000000",
    fileBytes: m0Image.length,
  },
  m0Image.subarray(0, 8),
);

describe("raw-binary segments load image", () => {
  it("verifies a Reset-derived Thumb entry at the base", () => {
    const f = thumbImage(resetLoad);
    const result = attestGhidraRawBinaryLoadImage(
      f.snapshot,
      f.target,
      f.observation,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "verified",
        layout: "segments",
        version: 1,
        format: "raw-binary",
        architecture: "arm",
        architecture_variant: "armv8-m.main",
        language_id: "ARM:LE:32:v8-m",
        file_bytes: m0Image.length,
        segments: [
          {
            name: "image",
            address: "0x8000000",
            size: m0Image.length,
            backing: { kind: "source-range", source: 0, offset: 0 },
          },
        ],
        entries: [
          {
            address: "0x8000040",
            isa_mode: "thumb",
            role: "reset",
            basis: "vector-table",
          },
        ],
        vector_table: {
          address: "0x8000000",
          initial_stack_pointer: "0x20001000",
          reset_vector: "0x08000041",
        },
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: "entry_context.TMode",
            matched: true,
            observed: "0x1",
          }),
        ]),
      },
    });
  });

  it.each([null, "0x0"])("refuses verification when TMode is %s", (tmode) => {
    const f = thumbImage(resetLoad, tmode);
    expect(
      attestGhidraRawBinaryLoadImage(f.snapshot, f.target, f.observation),
    ).toMatchObject({
      ok: true,
      value: {
        status: "mismatch",
        checks: expect.arrayContaining([
          expect.objectContaining({
            name: "entry_context.TMode",
            matched: false,
            observed: tmode,
          }),
        ]),
      },
    });
  });

  it("refuses verification when Ghidra reports another entry", () => {
    const f = thumbImage(resetLoad);
    // Applying ARMCortex.pspec's labels would make each vector slot an entry.
    f.observation.entry_points = ["0x4", "0x8", resetLoad.entryPoint];
    expect(
      attestGhidraRawBinaryLoadImage(f.snapshot, f.target, f.observation),
    ).toMatchObject({
      ok: true,
      value: {
        status: "mismatch",
        checks: expect.arrayContaining([
          expect.objectContaining({ name: "entry_points", matched: false }),
        ]),
      },
    });
  });

  it("retains a mismatch when Ghidra used the generic ARM decoder", () => {
    const f = thumbImage(resetLoad);
    f.observation.language_id = "ARM:LE:32:v7";
    expect(
      attestGhidraRawBinaryLoadImage(f.snapshot, f.target, f.observation),
    ).toMatchObject({ ok: true, value: { status: "mismatch" } });
  });

  it("describes a caller-named Thumb entry without a vector table", () => {
    const f = thumbImage(
      admittedRawLoad({
        architecture: "arm",
        architectureVariant: "armv7-m",
        baseAddress: "0x8000000",
        entryPoint: "0x8000056",
        fileBytes: m0Image.length,
      }),
    );
    const result = attestGhidraRawBinaryLoadImage(
      f.snapshot,
      f.target,
      f.observation,
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "verified",
        layout: "segments",
        architecture_variant: "armv7-m",
        language_id: "ARM:LE:32:Cortex",
        entries: [
          {
            address: "0x8000056",
            isa_mode: "thumb",
            role: "entry",
            basis: "caller",
          },
        ],
      },
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.value).not.toHaveProperty("vector_table");
  });

  it("reports the same load image for spellings of the same load", () => {
    // A reused session keeps the first admitted load; it must report what the
    // current request would.
    const spelled = (baseAddress: string, vectorTableAddress?: string) => {
      const f = thumbImage(
        admittedRawLoad(
          {
            architecture: "arm",
            architectureVariant: "armv8-m.main",
            entryPoint: undefined,
            baseAddress,
            ...(vectorTableAddress === undefined ? {} : { vectorTableAddress }),
            fileBytes: m0Image.length,
          },
          m0Image.subarray(0, 8),
        ),
      );
      return attestGhidraRawBinaryLoadImage(
        f.snapshot,
        f.target,
        f.observation,
      );
    };
    expect(spelled("0x8000000")).toEqual(spelled("0x08000000"));
    expect(spelled("0x8000000")).toEqual(spelled("0x8000000", "0x08000000"));
  });
});
