import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  ERLANG_BEAM_BUDGETS,
  inspectErlangBeamInputSchema,
} from "../domain/erlang/beam.js";
import { ArtifactReaderFailure } from "../resources/ArtifactReader.js";
import {
  erlangBeamChunksFixture,
  erlangBeamRowsFixture,
  erlangBeamFixture,
  erlangBeamLegacyAtomsFixture,
  erlangBeamOtp29Fixture,
} from "./Beam.fixture.js";
import { parseErlangBeamFromHandle } from "./BeamParser.js";
import { BeamProvider } from "./BeamProvider.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";

/** The BEAM parser's own structural refusal, with its parsed facts. */
const beamFailure = (kind: "malformed" | "truncated", detail: string) =>
  expect.objectContaining({
    name: "ParseFailureError",
    failure: expect.objectContaining({ kind, format: "beam", detail }),
  });

const ERLANG_BEAM_TABLE_ROWS_DEFAULT =
  ERLANG_BEAM_BUDGETS.max_table_rows.default_value;
const defaults = inspectErlangBeamInputSchema.parse({
  path: "/artifacts/app.beam",
});

const parse = (
  bytes: Buffer,
  input = defaults,
  observeRead?: (offset: number, length: number) => void,
) => {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return parseErlangBeamFromHandle(
    {
      sha256,
      size: bytes.length,
      prefix: bytes.subarray(0, 12),
      readRange: async (offset, length) => {
        observeRead?.(offset, length);
        return bytes.subarray(offset, offset + length);
      },
    },
    { path: input.path, sha256, bytes: bytes.length },
    input,
  );
};

it("streams bounded Code and opaque payload reads and keeps the last Code header", async () => {
  const window = 1024 * 1024;
  const code = Buffer.alloc(window + 123, 0x62);
  [16, 0, 169, 4, 2].forEach((field, index) =>
    code.writeUInt32BE(field, 4 * index),
  );
  const decoy = Buffer.from(code.subarray(0, 20));
  decoy.writeUInt32BE(99, 16);
  const opaque = Buffer.alloc(window + 3, 0x63);
  const bytes = erlangBeamChunksFixture([
    ["Code", decoy],
    ["Code", code],
    ["Dbgi", opaque],
  ]);
  const reads: [offset: number, length: number][] = [];
  const streamed = await parse(bytes, defaults, (offset, length) =>
    reads.push([offset, length]),
  );
  const codeStart = 48;
  const codeEnd = codeStart + code.length;
  const opaqueStart = codeEnd + 1 + 8; // One padding byte and the next header.
  expect(streamed.code).toEqual({
    instruction_set: 0,
    opcode_max: 169,
    labels: 4,
    functions: 2,
    extra_header_bytes: 0,
    instructions: { offset: codeStart + 20, bytes: code.length - 20 },
  });
  expect(streamed.chunks.map(({ payload }) => payload)).toEqual(
    [decoy, code, opaque].map((payload, index) => ({
      location: {
        offset: [20, codeStart, opaqueStart][index],
        bytes: payload.length,
      },
      bytes: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
    })),
  );
  expect(reads).toEqual([
    [12, 8],
    [20, 20],
    [40, 8],
    [codeStart, window],
    [codeStart + window, 123],
    [opaqueStart - 8, 8],
    [opaqueStart, window],
    [opaqueStart + window, 3],
  ]);
});

it("refuses a declared chunk extent outside the BEAM form", async () => {
  const bytes = erlangBeamChunksFixture([["Code", Buffer.alloc(20)]]);
  bytes.writeUInt32BE(100, 16);
  await expect(parse(bytes)).rejects.toThrow(
    beamFailure("malformed", "BEAM chunk payload exceeds the form."),
  );
});

it("selects the last decoded payload of each repeated BEAM table", async () => {
  const original = erlangBeamFixture("selected");
  const decoy = erlangBeamFixture("decoy");
  const changedFields = new Map([
    ["ExpT", 8],
    ["ImpT", 12],
    ["FunT", 8],
  ]);
  for (let at = 12; at < decoy.length;) {
    const name = decoy.toString("latin1", at, at + 4);
    const size = decoy.readUInt32BE(at + 4);
    const field = changedFields.get(name);
    if (field !== undefined) decoy.writeUInt32BE(9, at + 8 + field);
    at += 8 + size + ((4 - (size % 4)) % 4);
  }
  const repeated = Buffer.concat([
    original.subarray(0, 12),
    decoy.subarray(12),
    original.subarray(12),
  ]);
  repeated.writeUInt32BE(repeated.length - 8, 4);
  const report = await parse(repeated);
  expect(report.module).toBe("selected");
  expect(report.atoms?.map(({ name }) => name)).toEqual([
    "selected",
    "module_info",
    "start",
    "erlang",
    "get_module_info",
  ]);
  expect(
    report.exports?.map(({ function: name, arity }) => [name, arity]),
  ).toEqual([
    ["start", 0],
    ["module_info", 0],
    ["module_info", 1],
  ]);
  expect(report.imports).toMatchObject([
    { module: "erlang", function: "get_module_info", arity: 1 },
  ]);
  expect(report.lambdas).toMatchObject([
    { function: "start", arity: 1, index: 0 },
  ]);
  const chunkNames = ["AtU8", "Code", "ExpT", "ImpT", "FunT"];
  expect(report.chunks.map(({ name }) => name)).toEqual([
    ...chunkNames,
    ...chunkNames,
  ]);
});

it("rejects a malformed selected atom table instead of using an earlier table", async () => {
  const original = erlangBeamFixture();
  const invalid = erlangBeamChunksFixture([["AtU8", Buffer.from([0])]]);
  const repeated = Buffer.concat([original, invalid.subarray(12)]);
  repeated.writeUInt32BE(repeated.length - 8, 4);
  await expect(parse(repeated)).rejects.toThrow(/truncated/);
});

it("falls back from an empty AtU8 to legacy Atom, while nonempty alternates keep precedence", async () => {
  const control = await parse(erlangBeamLegacyAtomsFixture());
  const empty = await parse(erlangBeamLegacyAtomsFixture(Buffer.alloc(0)));
  expect(empty.atoms).toEqual(control.atoms);
  expect(empty.atom_encoding).toBe("latin1");
  expect(empty.module).toBe("demo");
  expect(empty.exports?.[0]?.function).toBe("ÿ");
  expect(empty.chunks.map(({ name }) => name)).toEqual([
    "Atom",
    "AtU8",
    "ExpT",
  ]);
  expect(empty.chunks[1]?.payload.bytes).toBe(0);
  const alternate = await parse(
    erlangBeamLegacyAtomsFixture(
      Buffer.concat([
        Buffer.from([0, 0, 0, 2, 4]),
        Buffer.from("demo"),
        Buffer.from([3]),
        Buffer.from("new"),
      ]),
    ),
  );
  expect(alternate.atom_encoding).toBe("utf8");
  expect(alternate.exports?.[0]?.function).toBe("new");
  const zeroCount = await parse(erlangBeamLegacyAtomsFixture(Buffer.alloc(4)));
  expect(zeroCount.atom_encoding).toBe("utf8");
  expect(zeroCount.atoms).toEqual([]);
  expect(zeroCount.exports?.[0]?.function).toBeNull();
});

it.each([Buffer.from([0]), Buffer.from([0, 0, 0, 1])])(
  "rejects a malformed nonempty AtU8 without falling back: %j",
  async (payload) => {
    await expect(parse(erlangBeamLegacyAtomsFixture(payload))).rejects.toThrow(
      /truncated/,
    );
  },
);

it.each(["AtU8", "Atom"])(
  "does not turn an empty standalone %s atom table into decoded facts",
  async (name) => {
    await expect(
      parse(erlangBeamChunksFixture([[name, Buffer.alloc(0)]])),
    ).rejects.toThrow(/atom table is truncated/);
  },
);

it("uses the last AtU8 occurrence even when empty", async () => {
  const control = erlangBeamLegacyAtomsFixture(Buffer.from([0, 0, 0, 0]));
  const empty = erlangBeamChunksFixture([["AtU8", Buffer.alloc(0)]]);
  const bytes = Buffer.concat([control, empty.subarray(12)]);
  bytes.writeUInt32BE(bytes.length - 8, 4);
  const report = await parse(bytes);
  expect(report.atom_encoding).toBe("latin1");
  expect(report.exports?.[0]?.function).toBe("ÿ");
  expect(
    report.chunks
      .filter(({ name }) => name === "AtU8")
      .map(({ payload }) => payload.bytes),
  ).toEqual([4, 0]);
});

it.each([
  { payload: Buffer.alloc(0), expected: null },
  { payload: Buffer.alloc(4), expected: [] },
])(
  "distinguishes empty optional FunT from a zero row count: $payload",
  async ({ payload, expected }) => {
    const original = erlangBeamOtp29Fixture();
    const extension = erlangBeamChunksFixture([["FunT", payload]]);
    const bytes = Buffer.concat([original, extension.subarray(12)]);
    bytes.writeUInt32BE(bytes.length - 8, 4);
    const control = await parse(original);
    const report = await parse(bytes);
    expect(control.lambdas).toBeNull();
    expect(report.lambdas).toEqual(expected);
    expect(report.atoms).toEqual(control.atoms);
    expect(report.exports).toEqual(control.exports);
    expect(report.imports).toEqual(control.imports);
    expect(report.code).toEqual(control.code);
    expect(report.chunks.at(-1)?.payload.bytes).toBe(payload.length);
  },
);

it("does not reuse an earlier FunT when its last occurrence is empty", async () => {
  const original = erlangBeamFixture();
  const extension = erlangBeamChunksFixture([["FunT", Buffer.alloc(0)]]);
  const bytes = Buffer.concat([original, extension.subarray(12)]);
  bytes.writeUInt32BE(bytes.length - 8, 4);
  const report = await parse(bytes);
  expect(report.lambdas).toBeNull();
  expect(
    report.chunks
      .filter(({ name }) => name === "FunT")
      .map(({ payload }) => payload.bytes),
  ).toEqual([28, 0]);
});

it.each([Buffer.from([0]), Buffer.from([0, 0, 0, 1])])(
  "rejects truncated nonempty FunT payloads: %j",
  async (payload) => {
    await expect(
      parse(erlangBeamChunksFixture([["FunT", payload]])),
    ).rejects.toThrow(/lambda table is truncated/);
  },
);

it("accepts extended compact atom lengths and rejects truncated or overflowing values", async () => {
  const compactAtom = (length: Buffer, name: Buffer): Buffer =>
    erlangBeamChunksFixture([
      [
        "AtU8",
        Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), length, name]),
      ],
    ]);
  const name = Buffer.from("0123456789abcdef", "ascii");
  const extended = await parse(
    compactAtom(Buffer.from([0x18, 0x00, 0x10]), name),
  );
  expect(extended.module).toBe(name.toString("ascii"));
  await expect(
    parse(compactAtom(Buffer.from([0x18, 0x00]), name)),
  ).rejects.toThrow(/BEAM atom table is truncated/);
  await expect(parse(compactAtom(Buffer.from([0x19]), name))).rejects.toThrow(
    /BEAM atom length is not a u tag/,
  );
  await expect(
    parse(
      compactAtom(
        Buffer.from([0xd8, 0x80, 0, 0, 0, 0, 0, 0, 0]),
        Buffer.alloc(0),
      ),
    ),
  ).rejects.toThrow(/BEAM atom length encoding overflows/);
  await expect(
    parse(
      compactAtom(
        Buffer.from([0xf8, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
        Buffer.alloc(0),
      ),
    ),
  ).rejects.toThrow(/BEAM atom length encoding overflows/);
});

it("refuses truncated and non-BEAM FOR1 headers", async () => {
  await expect(parse(Buffer.from("FOR1"))).rejects.toThrow(
    beamFailure("truncated", "BEAM range 0 + 12 leaves the artifact."),
  );
  // A short foreign file is another format, not a truncated BEAM.
  await expect(parse(Buffer.from("\x7fELF"))).rejects.toThrow(
    beamFailure("malformed", "Expected a FOR1 IFF container."),
  );
  const foreign = erlangBeamChunksFixture([]);
  foreign.write("WAVE", 8);
  await expect(parse(foreign)).rejects.toThrow(
    beamFailure("malformed", "Expected a BEAM form type."),
  );
});

it("discloses bytes that trail the declared FOR1 form", async () => {
  const valid = erlangBeamFixture("trailing_probe");
  const clean = await parse(valid);
  expect(clean.coverage.status).toBe("complete");
  expect(clean.coverage.trailing_bytes).toBe(0);

  // Append foreign bytes past the declared form; a conformant file ends there.
  const trailing = Buffer.concat([valid, Buffer.from("APPENDEDOVERLAY!")]);
  const report = await parse(trailing);
  expect(report.form.location.bytes).toBe(valid.length);
  expect(report.coverage.status).toBe("partial");
  expect(report.coverage.trailing_bytes).toBe(16);
  // The surplus bytes are not misread as a chunk; examined facts are unchanged.
  expect(report.chunks).toEqual(clean.chunks);
  expect(report.coverage.examined_chunks).toBe(clean.coverage.examined_chunks);
  expect(report.limitations).toEqual([
    ...clean.limitations,
    `The declared FOR1 form ends at offset ${String(valid.length)}; 16 trailing bytes were not examined.`,
  ]);

  const single = await parse(Buffer.concat([valid, Buffer.from("!")]));
  expect(single.coverage.status).toBe("partial");
  expect(single.coverage.trailing_bytes).toBe(1);
  expect(single.limitations.at(-1)).toBe(
    `The declared FOR1 form ends at offset ${String(valid.length)}; 1 trailing byte was not examined.`,
  );
});

it("rejects a short remainder inside the BEAM form", async () => {
  const bytes = Buffer.alloc(16);
  bytes.write("FOR1");
  bytes.writeUInt32BE(8, 4);
  bytes.write("BEAM", 8);
  await expect(parse(bytes)).rejects.toThrow(/BEAM chunk header is truncated/);
});

it("rejects an AtU8 atom name that is not UTF-8", async () => {
  await expect(
    parse(
      erlangBeamChunksFixture([["AtU8", Buffer.from([0, 0, 0, 1, 1, 0xff])]]),
    ),
  ).rejects.toThrow(/BEAM atom name is not valid UTF-8/);
});

it("uses a one-byte length and preserves Latin-1 bytes in legacy Atom", async () => {
  const report = await parse(
    erlangBeamChunksFixture([
      ["Atom", Buffer.from([0, 0, 0, 1, 2, 0x61, 0xff])],
    ]),
  );
  expect(report).toMatchObject({
    atom_encoding: "latin1",
    module: "aÿ",
    atoms: [{ index: 1, name: "aÿ" }],
    coverage: { status: "complete" },
  });
});

it.each([
  ["a negative count", [0xff, 0xff, 0xff, 0xff, 0x20, 0x61, 0x62]],
  ["a compact length", [0, 0, 0, 1, 0x20, 0x61, 0x62]],
])("rejects %s in legacy Atom", async (_name, payload) => {
  await expect(
    parse(erlangBeamChunksFixture([["Atom", Buffer.from(payload)]])),
  ).rejects.toThrow(beamFailure("truncated", "BEAM atom table is truncated."));
});

it("checks aggregate table capacity after each table is framed", async () => {
  const below = Math.floor(ERLANG_BEAM_TABLE_ROWS_DEFAULT / 2);
  const overflow = ERLANG_BEAM_TABLE_ROWS_DEFAULT - below * 2 + 1;
  await expect(
    parse(
      erlangBeamRowsFixture([
        ["ExpT", below],
        ["ImpT", below],
        ["FunT", overflow],
      ]),
    ),
  ).rejects.toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        limit: {
          name: "max_table_rows",
          maximum: ERLANG_BEAM_TABLE_ROWS_DEFAULT,
          required: ERLANG_BEAM_TABLE_ROWS_DEFAULT + 1,
        },
      }),
    }),
  );
  const complete = Buffer.alloc(4 + (ERLANG_BEAM_TABLE_ROWS_DEFAULT + 1) * 12);
  complete.writeUInt32BE(ERLANG_BEAM_TABLE_ROWS_DEFAULT + 1);
  await expect(
    parse(
      erlangBeamChunksFixture([
        ["ExpT", complete],
        ["ImpT", Buffer.alloc(1)],
      ]),
    ),
  ).rejects.toThrow(/import table is truncated/);
  for (const [chunk, label] of [
    ["ExpT", "export"],
    ["ImpT", "import"],
    ["FunT", "lambda"],
  ] as const) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(ERLANG_BEAM_TABLE_ROWS_DEFAULT + 1);
    await expect(
      parse(erlangBeamChunksFixture([[chunk, count]])),
    ).rejects.toThrow(
      beamFailure("truncated", `BEAM ${label} table is truncated.`),
    );
  }
});

it.each([
  ["legacy Atom", "Atom", [0, 0, 0, 2], [1, 2]],
  ["classic AtU8", "AtU8", [0, 0, 0, 2], [1, 2]],
  ["compact AtU8", "AtU8", [0xff, 0xff, 0xff, 0xfe], [0x10, 0x20]],
] as const)(
  "checks only the admitted atom lengths in %s",
  async (_name, chunk, count, [validLength, invalidLength]) => {
    const fixture = (firstLength: number, lastByte: number) =>
      erlangBeamChunksFixture([
        [chunk, Buffer.from([...count, firstLength, 0x61, lastByte])],
      ]);
    const input = { ...defaults, max_atoms: 1 };
    const valid = fixture(validLength, 0);
    expect((await parse(valid)).atoms).toEqual([
      { index: 1, name: "a" },
      { index: 2, name: "" },
    ]);
    for (const bytes of [valid, fixture(validLength, validLength)]) {
      // The second name is complete or truncated, beyond the admitted prefix.
      await expect(parse(bytes, input)).rejects.toThrow(
        expect.objectContaining({
          failure: expect.objectContaining({
            kind: "limit",
            format: "beam",
            limit: { name: "max_atoms", maximum: 1, required: 2 },
          }),
        }),
      );
    }
    // The first name would consume the second entry's required length byte.
    await expect(parse(fixture(invalidLength, 0x62), input)).rejects.toThrow(
      beamFailure("truncated", "BEAM atom table is truncated."),
    );
  },
);

it("does not infer a BEAM budget from diagnostic prose", async () => {
  const provider = new BeamProvider();
  const injection = vi
    .spyOn(ArtifactResourceScope.prototype, "run")
    .mockRejectedValueOnce(
      new ArtifactReaderFailure(
        "limit",
        "atom row budget wording from another boundary",
        { boundary: "capacity" },
      ),
    );
  try {
    const result = await provider.inspect(defaults);
    if (result.ok) throw new Error("Expected unknown capacity failure");
    expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    if (!(result.error instanceof AnalysisResourceConstraintError))
      throw new Error("Missing resource error");
    expect(result.error.retryable).toBeUndefined();
    expect(result.error.remediationAction).toBeUndefined();
  } finally {
    injection.mockRestore();
    await provider.close();
  }
});

it.each([
  ["Atom", Buffer.from([0, 0, 0, 1, 1, 0x61])],
  ["AtU8", Buffer.from([0, 0, 0, 1, 1, 0x61])],
  ["AtU8", Buffer.from([0xff, 0xff, 0xff, 0xff, 0x10, 0x61])],
  ["ExpT", Buffer.alloc(4)],
  ["ImpT", Buffer.alloc(4)],
  ["FunT", Buffer.alloc(4)],
] as const)(
  "reports unexamined bytes inside a selected %s table",
  async (name, payload) => {
    const control = await parse(erlangBeamChunksFixture([[name, payload]]));
    const extended = Buffer.concat([payload, Buffer.from([0x61])]);
    const report = await parse(erlangBeamChunksFixture([[name, extended]]));
    expect(control.coverage.status).toBe("complete");
    expect(report.coverage).toMatchObject({
      status: "partial",
      trailing_bytes: 0,
    });
    expect(report.limitations).toContain(
      `The selected ${name} table has 1 trailing byte that was not examined.`,
    );
    for (const field of ["atoms", "exports", "imports", "lambdas"] as const)
      expect(report[field]).toEqual(control[field]);
  },
);
