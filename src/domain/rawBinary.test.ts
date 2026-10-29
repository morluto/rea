import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { executableFormatHintSchema } from "./dosCom.js";
import {
  admitRawBinary,
  isLegacyRawLoad,
  rawLoadIdentity,
  rawLoadIdentitySchema,
  parseRawBinaryEntryPoint,
  rawBinarySelectionError,
  validateRawBinaryLength,
} from "./rawBinary.js";
import {
  ARCHITECTURE_VARIANT_NAMES,
  ARCHITECTURE_VARIANTS,
  type ArchitectureVariant,
} from "./architectureVariant.js";
import { admittedRawLoad, vectorTableWords } from "./rawBinary.fixture.js";

describe("headerless format hints", () => {
  it("admits dos-com and raw-binary names only", () => {
    expect(executableFormatHintSchema.safeParse("dos-com").success).toBe(true);
    expect(executableFormatHintSchema.safeParse("raw-binary").success).toBe(
      true,
    );
    expect(executableFormatHintSchema.safeParse("raw").success).toBe(false);
  });
});

describe("raw-binary entry addresses", () => {
  it("canonicalizes equivalent hex spellings without dropping the source", () => {
    const parsed = parseRawBinaryEntryPoint("0x08000000");
    expect(parsed).toEqual({
      ok: true,
      value: {
        source: "0x08000000",
        canonical: "0x8000000",
        value: 0x8000000n,
      },
    });
  });
  it.each(["8000000", "0x", "0xgg", "0X8000000", ""])(
    "rejects malformed entry %s",
    (value) => {
      expect(parseRawBinaryEntryPoint(value)).toEqual({
        ok: false,
        error: "entry_point must be a hexadecimal address of the form 0x…",
      });
    },
  );
});

describe("6502 raw-binary admission", () => {
  it("admits byte-aligned 6502 images up to the 16-bit address boundary", () => {
    for (const [entryPoint, fileBytes] of [
      ["0x8001", 8],
      ["0xffff", 1],
      ["0x0", 65536],
    ] as const) {
      const result = admitRawBinary({
        architecture: "6502",
        entryPoint,
        fileBytes,
      });
      if (!result.ok) throw new Error(result.error.reason);
      expect(result.value).toEqual({
        architecture: "6502",
        load: {
          baseAddress: entryPoint,
          entryPoint,
          entrySource: { kind: "caller" },
        },
      });
    }
  });
  it.each([
    ["0x10000", 1],
    ["0xffff", 2],
    ["0x0", 65537],
  ])(
    "rejects a 6502 mapping at %s with %i bytes that exceeds 16 bits",
    (entryPoint, fileBytes) => {
      const result = admitRawBinary({
        architecture: "6502",
        entryPoint,
        fileBytes,
      });
      if (result.ok) throw new Error("expected 16-bit overflow rejection");
      expect(result.error).toEqual({
        reason: `raw-binary mapping from ${entryPoint} must fit in the 6502 address width`,
        constraint: "load_selection_rejected",
        field: "entry_point",
      });
    },
  );
});

describe("raw-binary admission", () => {
  it("admits a little-endian ARM image mapped at the caller entry", () => {
    expect(
      admitRawBinary({
        architecture: "arm",
        entryPoint: "0x8000000",
        fileBytes: 4,
      }),
    ).toEqual({
      ok: true,
      value: {
        architecture: "arm",
        load: {
          baseAddress: "0x8000000",
          entryPoint: "0x8000000",
          entrySource: { kind: "caller" },
        },
      },
    });
  });
  it("rejects an empty file as a target refusal while naming the extent", () => {
    expect(validateRawBinaryLength(0).ok).toBe(false);
    const result = admitRawBinary({
      architecture: "x86",
      entryPoint: "0x1000",
      fileBytes: 0,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        reason: "raw-binary requires at least one file byte",
        constraint: "file_format_rejected",
      },
    });
  });
  it("rejects a 32-bit mapping that exceeds the architecture width", () => {
    const result = admitRawBinary({
      architecture: "arm",
      entryPoint: "0xfffffffc",
      fileBytes: 8,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected overflow rejection");
    expect(result.error.reason).toContain("arm address width");
    expect(result.error.constraint).toBe("load_selection_rejected");
  });
  it("allows a 64-bit mapping that would overflow 32-bit ARM", () => {
    expect(
      admitRawBinary({
        architecture: "arm64",
        entryPoint: "0xfffffffc",
        fileBytes: 8,
      }).ok,
    ).toBe(true);
  });
  it.each(["arm", "arm64"])(
    "rejects unaligned %s entries before provider selection",
    (architecture) => {
      for (const entryPoint of ["0x8000001", "0x8000002", "0x8000003"]) {
        // An odd 32-bit ARM entry also suggests the M-profile inputs.
        const thumbHint =
          architecture === "arm" && BigInt(entryPoint) % 2n !== 0n;
        expect(
          admitRawBinary({ architecture, entryPoint, fileBytes: 4 }),
        ).toEqual({
          ok: false,
          error: {
            reason: `raw-binary ${architecture} entry_point ${entryPoint} must be 4-byte aligned`,
            constraint: "load_selection_rejected",
            field: "entry_point",
            ...(thumbHint
              ? {
                  diagnostics: {
                    entry_point: entryPoint,
                    suggestion: expect.stringContaining("architecture_variant"),
                  },
                }
              : {}),
          },
        });
      }
    },
  );
  it.each([
    ["malformed entry", { architecture: "arm", entryPoint: "0xgg" }],
    ["missing entry", { architecture: "arm", entryPoint: undefined }],
    [
      "missing architecture",
      { architecture: undefined, entryPoint: "0x8000000" },
    ],
    ["mismatched family name", { architecture: "68000", entryPoint: "0x1000" }],
  ])("classifies a %s as caller input", (_name, selection) => {
    const result = admitRawBinary({ ...selection, fileBytes: 4 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected caller-input rejection");
    expect(result.error.constraint).toBe("load_selection_rejected");
  });
  it.each(["x86", "x86_64"])(
    "admits byte-aligned %s entries",
    (architecture) => {
      const admitted = admitRawBinary({
        architecture,
        entryPoint: "0x1001",
        fileBytes: 1,
      });
      if (!admitted.ok) throw new Error(admitted.error.reason);
      expect(admitted.value).toMatchObject({ load: { entryPoint: "0x1001" } });
    },
  );
});

describe("m68k raw-binary admission", () => {
  it("admits even m68k entries up to the 32-bit address boundary", () => {
    for (const [entryPoint, fileBytes] of [
      ["0x0", 8],
      ["0x1000", 8],
      ["0xfffffffe", 2],
    ] as const) {
      const result = admitRawBinary({
        architecture: "m68k",
        entryPoint,
        fileBytes,
      });
      if (!result.ok) throw new Error(result.error.reason);
      expect(result.value).toEqual({
        architecture: "m68k",
        load: {
          baseAddress: entryPoint,
          entryPoint,
          entrySource: { kind: "caller" },
        },
      });
    }
  });
  it.each(["0x1", "0x1001", "0x1003", "0xffffffff"])(
    "rejects the odd m68k entry %s before provider selection",
    (entryPoint) => {
      expect(
        admitRawBinary({ architecture: "m68k", entryPoint, fileBytes: 2 }),
      ).toEqual({
        ok: false,
        error: {
          reason: `raw-binary m68k entry_point ${entryPoint} must be 2-byte aligned`,
          constraint: "load_selection_rejected",
          field: "entry_point",
        },
      });
    },
  );
  it.each([
    ["0x100000000", 2],
    ["0xfffffffe", 4],
  ])(
    "rejects an m68k mapping at %s with %i bytes that exceeds 32 bits",
    (entryPoint, fileBytes) => {
      expect(
        admitRawBinary({ architecture: "m68k", entryPoint, fileBytes }),
      ).toEqual({
        ok: false,
        error: {
          reason: `raw-binary mapping from ${entryPoint} must fit in the m68k address width`,
          constraint: "load_selection_rejected",
          field: "entry_point",
        },
      });
    },
  );
});

describe("raw-binary selection pairing", () => {
  it("requires architecture and entry with format=raw-binary", () => {
    expect(rawBinarySelectionError({ format: "raw-binary" })).toEqual({
      field: "architecture",
      message: "format=raw-binary requires architecture and entry_point",
    });
    expect(
      rawBinarySelectionError({
        format: "raw-binary",
        architecture: "arm",
        entryPoint: "0x8000000",
      }),
    ).toBeUndefined();
  });
  it("rejects architecture or entry without format=raw-binary", () => {
    expect(
      rawBinarySelectionError({ architecture: "arm", entryPoint: "0x1" }),
    ).toEqual({
      field: "architecture",
      message: "architecture and entry_point apply only with format=raw-binary",
    });
    expect(
      rawBinarySelectionError({ format: "dos-com", entryPoint: "0x1" }),
    ).toEqual({
      field: "entry_point",
      message: "architecture and entry_point apply only with format=raw-binary",
    });
  });
});

describe("raw-binary admission results", () => {
  const sha256 = (value: unknown): string =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  // Computed at d6f88becd over every combination below, without the caller's
  // entry spelling, which the admitted load no longer keeps. Changing how the
  // load is represented must not change any accepted value, refusal reason or
  // constraint.
  const ADMISSION_GRID_SHA256 =
    "930f0a2a9fbab8177d89ca8161f21bc2cb472b095286282ca362ced5d2dbec50";
  const PAIRING_GRID_SHA256 =
    "b6447afda4012589d57f8bc0710fa8d85066e332f932103e30556232d1f3eca7";
  const architectures = [
    undefined,
    "x86",
    "x86_64",
    "arm",
    "arm64",
    "6502",
    "m68k",
    "mips",
    "68000",
    7,
  ];
  const entryPoints = [
    undefined,
    "0x0",
    "0x1",
    "0x2",
    "0x3",
    "0x4",
    "0x8001",
    "0xffff",
    "0x10000",
    "0x08000000",
    "0x8000001",
    "0x8000002",
    "0xfffffffc",
    "0xfffffffe",
    "0xffffffff",
    "0x100000000",
    "0xFFFFFFFFFFFFFFFF",
    "0x",
    "8000",
    0x8000,
  ];
  const fileSizes = [
    0,
    1,
    2,
    4,
    8,
    65_536,
    65_537,
    2 ** 32,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ];
  const admitted = (result: ReturnType<typeof admitRawBinary>) =>
    !result.ok
      ? { reason: result.error.reason, constraint: result.error.constraint }
      : "admit" in result.value
        ? { vector_table_offset: result.value.fileOffset }
        : {
            architecture: result.value.architecture,
            base: result.value.load.baseAddress,
            entry: result.value.load.entryPoint,
          };

  it("keeps every admission result", () => {
    const rows = architectures.flatMap((architecture) =>
      entryPoints.flatMap((entryPoint) =>
        fileSizes.map((fileBytes) => [
          architecture,
          entryPoint,
          fileBytes,
          admitted(admitRawBinary({ architecture, entryPoint, fileBytes })),
        ]),
      ),
    );
    expect(rows).toHaveLength(2_200);
    expect(sha256(rows)).toBe(ADMISSION_GRID_SHA256);
  });

  it("keeps every format, architecture and entry pairing result", () => {
    const rows = [undefined, ...executableFormatHintSchema.options].flatMap(
      (format) =>
        [undefined, "arm"].flatMap((architecture) =>
          [undefined, "0x8000000"].map((entryPoint) => [
            format,
            architecture,
            entryPoint,
            rawBinarySelectionError({
              ...(format === undefined ? {} : { format }),
              architecture,
              entryPoint,
            })?.message ?? null,
          ]),
        ),
    );
    expect(rows).toHaveLength(16);
    expect(sha256(rows)).toBe(PAIRING_GRID_SHA256);
  });
});

describe("raw-binary base address admission", () => {
  it.each(["x86", "arm", "m68k", "6502"] as const)(
    "refuses a %s base_address without architecture_variant",
    (architecture) => {
      expect(
        admitRawBinary({
          architecture,
          baseAddress: "0x1000",
          entryPoint: "0x1000",
          fileBytes: 8,
        }),
      ).toEqual({
        ok: false,
        error: {
          reason: "base_address applies only with architecture_variant",
          constraint: "load_selection_rejected",
          field: "base_address",
        },
      });
    },
  );
  it("maps file offset 0 at a separate base and keeps the entry inside", () => {
    const result = admitRawBinary({
      architecture: "arm",
      architectureVariant: "armv7-m",
      baseAddress: "0x08000000",
      entryPoint: "0x8000004",
      fileBytes: 8,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        architecture: "arm",
        load: {
          baseAddress: "0x8000000",
          architectureVariant: "armv7-m",
          entryPoint: "0x8000004",
          entryIsaMode: "thumb",
          entrySource: { kind: "caller" },
        },
      },
    });
    if (!result.ok || "admit" in result.value)
      throw new Error("expected an admitted load");
    expect(isLegacyRawLoad(result.value.load)).toBe(false);
  });
  it.each(["0x7fffffc", "0x8000008"])(
    "refuses entry %s outside the mapped image",
    (entryPoint) => {
      expect(
        admitRawBinary({
          architecture: "arm",
          architectureVariant: "armv7-m",
          baseAddress: "0x8000000",
          entryPoint,
          fileBytes: 8,
        }),
      ).toEqual({
        ok: false,
        error: {
          reason: `raw-binary entry_point ${entryPoint} must lie inside the image mapped at 0x8000000..0x8000007`,
          constraint: "load_selection_rejected",
          field: "entry_point",
        },
      });
    },
  );
  it("measures the address width from the base", () => {
    expect(
      admitRawBinary({
        architecture: "arm",
        architectureVariant: "armv7-m",
        baseAddress: "0xfffffff0",
        entryPoint: "0xfffffff0",
        fileBytes: 32,
      }),
    ).toMatchObject({
      ok: false,
      error: {
        reason:
          "raw-binary mapping from 0xfffffff0 must fit in the arm address width",
        field: "base_address",
      },
    });
  });
  it("refuses a malformed base", () => {
    expect(
      admitRawBinary({
        architecture: "arm",
        architectureVariant: "armv7-m",
        baseAddress: "8000000",
        entryPoint: "0x8000000",
        fileBytes: 4,
      }),
    ).toEqual({
      ok: false,
      error: {
        reason: "base_address must be a hexadecimal address of the form 0x…",
        constraint: "load_selection_rejected",
        field: "base_address",
      },
    });
  });
  it("suggests the M-profile inputs for an odd generic ARM entry", () => {
    expect(
      admitRawBinary({
        architecture: "arm",
        entryPoint: "0x080001c5",
        fileBytes: 0x200,
      }),
    ).toEqual({
      ok: false,
      error: {
        reason: "raw-binary arm entry_point 0x80001c5 must be 4-byte aligned",
        constraint: "load_selection_rejected",
        field: "entry_point",
        diagnostics: {
          entry_point: "0x080001c5",
          suggestion: expect.stringContaining("architecture_variant"),
        },
      },
    });
  });
});

const vectorWords = vectorTableWords;

const vectorTableRead = (
  variant: ArchitectureVariant,
  selection: {
    readonly baseAddress: string;
    readonly vectorTableAddress?: string;
    readonly fileBytes: number;
  },
) => {
  const result = admitRawBinary({
    architecture: ARCHITECTURE_VARIANTS[variant].architecture,
    architectureVariant: variant,
    entryPoint: undefined,
    ...selection,
  });
  if (!result.ok) throw new Error(result.error.reason);
  if (!("admit" in result.value))
    throw new Error("expected a vector-table read");
  return result.value;
};

describe.each(ARCHITECTURE_VARIANT_NAMES)(
  "raw-binary %s explicit entry admission",
  (variant) => {
    const { architecture, isaMode } = ARCHITECTURE_VARIANTS[variant];

    // A code fragment that starts at its entry passes that address as its base.
    it("admits an even Thumb entry that generic ARM would refuse", () => {
      expect(
        admitRawBinary({
          architecture,
          architectureVariant: variant,
          baseAddress: "0x8000002",
          entryPoint: "0x8000002",
          fileBytes: 4,
        }),
      ).toEqual({
        ok: true,
        value: {
          architecture,
          load: {
            baseAddress: "0x8000002",
            architectureVariant: variant,
            entryPoint: "0x8000002",
            entryIsaMode: isaMode,
            entrySource: { kind: "caller" },
          },
        },
      });
    });

    it("refuses an odd entry and gives its code address", () => {
      const result = admitRawBinary({
        architecture,
        architectureVariant: variant,
        entryPoint: "0x080001c5",
        baseAddress: "0x08000000",
        fileBytes: 0x200,
      });
      expect(result).toMatchObject({
        ok: false,
        error: {
          reason: `raw-binary ${variant} entry_point 0x80001c5 is a Thumb interworking address with bit 0 set; its code address is 0x80001c4`,
          constraint: "load_selection_rejected",
          diagnostics: {
            entry_point: "0x080001c5",
            code_address: "0x80001c4",
            isa_mode: isaMode,
            suggestion:
              "Omit entry_point to read Reset from the vector table, or pass code_address as entry_point.",
          },
        },
      });
    });

    it("refuses a vector table address beside an explicit entry", () => {
      expect(
        admitRawBinary({
          architecture,
          architectureVariant: variant,
          baseAddress: "0x8000000",
          entryPoint: "0x8000100",
          vectorTableAddress: "0x8000000",
          fileBytes: 0x200,
        }),
      ).toMatchObject({
        ok: false,
        error: {
          reason:
            "vector_table_address locates Reset only when entry_point is omitted",
        },
      });
    });
  },
);

describe.each(ARCHITECTURE_VARIANT_NAMES)(
  "raw-binary %s vector-table admission",
  (variant) => {
    const { architecture, isaMode } = ARCHITECTURE_VARIANTS[variant];
    const derived = (selection: Parameters<typeof vectorTableRead>[1]) =>
      vectorTableRead(variant, selection);

    it("reads Reset from the vector table at the base", () => {
      const read = derived({ baseAddress: "0x08000000", fileBytes: 0x200 });
      // Words 0 and 1: the initial stack pointer and Reset.
      expect(read).toMatchObject({ fileOffset: 0, byteLength: 8 });
      expect(read.admit(vectorWords(0x20005000, 0x080001c5))).toEqual({
        ok: true,
        value: {
          architecture,
          load: {
            baseAddress: "0x8000000",
            architectureVariant: variant,
            entryPoint: "0x80001c4",
            entryIsaMode: isaMode,
            entrySource: {
              kind: "vector-table",
              address: "0x8000000",
              resetVector: "0x080001c5",
              initialStackPointer: "0x20005000",
            },
          },
        },
      });
    });

    it("refuses a default vector table at a base VTOR cannot hold", () => {
      expect(
        admitRawBinary({
          architecture,
          architectureVariant: variant,
          baseAddress: "0x8000040",
          entryPoint: undefined,
          fileBytes: 0x200,
        }),
      ).toEqual({
        ok: false,
        error: {
          reason:
            "raw-binary vector table at 0x8000040 must be 128-byte aligned, as VTOR requires; it is at base_address unless vector_table_address is given",
          constraint: "load_selection_rejected",
          field: "base_address",
        },
      });
    });

    it("reads Reset from a vector table after a header", () => {
      const read = derived({
        baseAddress: "0x10000000",
        vectorTableAddress: "0x10000100",
        fileBytes: 0x400,
      });
      expect(read.fileOffset).toBe(0x100);
      expect(read.admit(vectorWords(0x20042000, 0x100001f7))).toMatchObject({
        ok: true,
        value: {
          load: {
            entryPoint: "0x100001f6",
            entrySource: {
              kind: "vector-table",
              address: "0x10000100",
            },
          },
        },
      });
    });

    it.each([
      [0x080001c4, "is even"],
      [0x090001c5, "outside the image mapped at 0x8000000..0x80001ff"],
      [0x07ffff01, "outside the image mapped at 0x8000000..0x80001ff"],
      [0x08000005, "inside the vector-table words read at 0x8000000"],
    ])("refuses Reset word %i", (reset, reason) => {
      const result = derived({
        baseAddress: "0x8000000",
        fileBytes: 0x200,
      }).admit(vectorWords(0x20005000, reset));
      expect(result).toMatchObject({
        ok: false,
        error: {
          reason: expect.stringContaining(reason),
          constraint: "load_selection_rejected",
          diagnostics: {
            vector_table_address: "0x8000000",
            initial_stack_pointer: "0x20005000",
            reset_vector: `0x${reset.toString(16).padStart(8, "0")}`,
          },
        },
      });
      // No single input is to blame for the words read.
      expect(result).not.toHaveProperty(["error", "field"]);
    });

    it.each([
      ["0x8000002", 0x200, "must be 128-byte aligned, as VTOR requires"],
      // Naming the Reset slot instead of the table would read NMI as Reset.
      ["0x8000004", 0x200, "must be 128-byte aligned, as VTOR requires"],
      ["0x8000200", 0x200, "must lie inside the image mapped at"],
      ["0x7ffff80", 0x200, "must lie inside the image mapped at"],
      ["0x8000180", 0x184, "file ends before the Reset vector at 0x8000184"],
      [undefined, 4, "file ends before the Reset vector at 0x8000004"],
    ])(
      "refuses vector table %s in a %i-byte image",
      (vectorTableAddress, fileBytes, reason) => {
        const result = admitRawBinary({
          architecture,
          architectureVariant: variant,
          baseAddress: "0x8000000",
          entryPoint: undefined,
          ...(vectorTableAddress === undefined ? {} : { vectorTableAddress }),
          fileBytes,
        });
        expect(result).toMatchObject({
          ok: false,
          error: {
            reason: expect.stringContaining(reason),
            constraint: "load_selection_rejected",
          },
        });
        // A named table is the input to move; no base moves one at offset 0.
        if (result.ok) return;
        expect(result.error.field).toBe(
          vectorTableAddress === undefined ? undefined : "vector_table_address",
        );
      },
    );
  },
);

describe("raw-binary variant pairing at admission", () => {
  it("refuses a variant of another family and an unknown variant", () => {
    expect(
      admitRawBinary({
        architecture: "x86",
        architectureVariant: "armv7-m",
        entryPoint: "0x1000",
        fileBytes: 4,
      }),
    ).toMatchObject({
      ok: false,
      error: {
        reason: "architecture_variant armv7-m requires architecture arm",
        field: "architecture_variant",
      },
    });
    expect(
      admitRawBinary({
        architecture: "arm",
        architectureVariant: "cortex-m",
        entryPoint: "0x1000",
        fileBytes: 4,
      }),
    ).toMatchObject({
      ok: false,
      error: {
        reason: `architecture_variant must be one of ${ARCHITECTURE_VARIANT_NAMES.join(", ")}`,
        field: "architecture_variant",
      },
    });
  });
  it.each([
    [
      { architectureVariant: "armv7-m" },
      "architecture_variant requires base_address, the address of file offset 0",
      "base_address",
    ],
    [
      { baseAddress: "0x8000000" },
      "base_address applies only with architecture_variant",
      "base_address",
    ],
    [
      { vectorTableAddress: "0x8000000" },
      "entry_point may be omitted only with architecture_variant and base_address; Reset is then read from the vector table",
      "entry_point",
    ],
  ] as const)(
    "requires a variant and a base to omit the entry: %j",
    (selection, reason, field) => {
      expect(
        admitRawBinary({
          architecture: "arm",
          entryPoint: undefined,
          ...selection,
          fileBytes: 8,
        }),
      ).toEqual({
        ok: false,
        error: { reason, constraint: "load_selection_rejected", field },
      });
    },
  );
});

describe("raw load identity", () => {
  const thumbReset = vectorTableWords(0x20005000, 0x080001c5);
  const reset = (vectorTableAddress?: string, baseAddress = "0x08000000") =>
    rawLoadIdentity(
      admittedRawLoad(
        {
          architecture: "arm",
          architectureVariant: "armv7-m",
          entryPoint: undefined,
          baseAddress,
          ...(vectorTableAddress === undefined ? {} : { vectorTableAddress }),
          fileBytes: 0x200,
        },
        thumbReset,
      ),
    );

  it("leaves a load without a variant with its earlier identity", () => {
    expect(
      rawLoadIdentity(
        admittedRawLoad({
          architecture: "arm",
          entryPoint: "0x08000000",
          fileBytes: 4,
        }),
      ),
    ).toBeUndefined();
  });

  it("identifies a Reset-derived load by resolved values only", () => {
    expect(reset()).toEqual({
      version: 1,
      base_address: "0x8000000",
      architecture_variant: "armv7-m",
      vector_table_address: "0x8000000",
      entries: [
        {
          address: "0x80001c4",
          isa_mode: "thumb",
          role: "reset",
          basis: "vector-table",
        },
      ],
    });
  });

  it("keeps identity across spellings and provenance", () => {
    // Base spelling, and an explicit vector table at the default location.
    expect(reset(undefined, "0x8000000")).toEqual(reset());
    expect(reset("0x08000000")).toEqual(reset());
  });

  it("separates vector tables with the same Reset word", () => {
    // Their initial stack pointers can differ, and results report them.
    expect(reset("0x08000100")).toEqual({
      ...reset(),
      vector_table_address: "0x8000100",
    });
  });

  it.each([
    "armv6-m",
    "armv7-m",
    "armv7e-m",
    "armv8-m.base",
    "armv8-m.main",
    "armv8.1-m.main",
  ])("keeps the persisted variant name %s readable in snapshots", (name) => {
    expect(
      rawLoadIdentitySchema.shape.architecture_variant.safeParse(name).success,
    ).toBe(true);
  });

  // Session identity covers the reported basis; coordinate identity does not
  // (see GhidraRawProfileDigest.test.ts).
  it("separates a caller-named entry from Reset at the same address", () => {
    const selected = rawLoadIdentity(
      admittedRawLoad({
        architecture: "arm",
        architectureVariant: "armv7-m",
        baseAddress: "0x8000000",
        entryPoint: "0x80001c4",
        fileBytes: 0x200,
      }),
    );
    expect(selected).toEqual({
      version: 1,
      base_address: "0x8000000",
      architecture_variant: "armv7-m",
      entries: [
        {
          address: "0x80001c4",
          isa_mode: "thumb",
          role: "entry",
          basis: "caller",
        },
      ],
    });
    expect(selected).not.toEqual(reset());
  });
});
