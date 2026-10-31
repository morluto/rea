import { SOLC_JSON_LIMITS } from "./solcCompilerJson.js";
import { describe, expect, it } from "vitest";
import { solcArtifactSchema, type CompilerSelection } from "./solcArtifact.js";
import { selectSolcArtifact } from "./solcArtifactSelection.js";

const selection: CompilerSelection = {
  source_unit: "src/雪~.sol",
  contract_name: "C",
  bytecode_kind: "creation",
};
const select = (text: string, chosen = selection) =>
  selectSolcArtifact(new TextEncoder().encode(text), chosen);
const carrier = (object: unknown, extras = {}) =>
  JSON.stringify({
    contracts: {
      [selection.source_unit]: {
        C: {
          evm: {
            bytecode: { object, ...extras },
            deployedBytecode: { object: "6002" },
          },
        },
      },
    },
  });
const successful = (text: string, chosen = selection) => {
  const result = select(text, chosen);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe("exact recorded solc artifact selection", () => {
  it("retains exact syntax coordinates and opaque Unicode source identity", () => {
    const text = carrier("60Ab");
    const result = successful(text);
    expect([...(result.bytes ?? [])]).toEqual([0x60, 0xab]);
    expect(result.artifact.json_pointer).toBe(
      "/contracts/src~1雪~0.sol/C/evm/bytecode",
    );
    expect(result.artifact.object).toBe("60Ab");
    const span = result.artifact.object_range;
    expect(span && text.slice(span.start, span.end)).toBe('"60Ab"');
    expect(solcArtifactSchema.parse(result.artifact)).toEqual(result.artifact);
    expect(
      successful(text, { ...selection, bytecode_kind: "deployed" }).artifact
        .object,
    ).toBe("6002");
    const missing = select(text, { ...selection, source_unit: "雪~.sol" });
    expect(missing.ok ? null : missing.error.reason).toBe("selection");
  });

  it("preserves unlinked objects and unknown references without byte inference", () => {
    const placeholder = `__$${"a".repeat(34)}$__`;
    const result = successful(
      carrier(`60${placeholder}`, {
        linkReferences: { "lib.sol": { L: [{ start: 1, length: 20 }] } },
      }),
    );
    expect(result.bytes).toBeNull();
    expect(result.artifact.status).toBe("unlinked");
    expect(result.artifact.placeholders).toEqual([
      { start: 1, length: 20, value: placeholder },
    ]);
    expect(result.artifact.link_references?.[0]).toMatchObject({
      source_unit: "lib.sol",
      library_name: "L",
      start: 1,
      length: 20,
    });
    const absent = successful(
      JSON.stringify({
        contracts: { [selection.source_unit]: { C: {} } },
        errors: [
          { severity: "error", errorCode: 123, message: "compile failed" },
        ],
      }),
    );
    expect(absent.artifact.status).toBe("absent");
    expect(absent.bytes).toBeNull();
    expect(absent.artifact.diagnostics?.[0]?.raw_json).toContain(
      '"errorCode":123',
    );
    expect(absent.artifact.link_references).toBeNull();
  });

  it("preserves diagnostic numeric lexemes and selected metadata without authenticating them", () => {
    const metadata =
      '{"compiler":{"version":"0.8.30"},"settings":{"x":9007199254740993}}';
    const text = `{"contracts":{"src/雪~.sol":{"C":{"evm":{"bytecode":{"object":""}},"metadata":${JSON.stringify(metadata)}}}},"errors":[{"severity":"warning","n":9007199254740993}]}`;
    const result = successful(text);
    expect(result.artifact.diagnostics?.[0]?.raw_json).toContain(
      "9007199254740993",
    );
    expect(result.artifact.metadata).toMatchObject({
      raw: metadata,
      compiler_version: "0.8.30",
      settings_json: '{"x":9007199254740993}',
      parse_status: "valid",
    });
    expect(result.bytes).toHaveLength(0);
  });

  it("retains malformed metadata and reference extent uncertainty for absent objects", () => {
    const text = JSON.stringify({
      contracts: {
        [selection.source_unit]: {
          C: {
            metadata: "{broken",
            evm: {
              bytecode: {
                immutableReferences: { "1": [{ start: 4, length: 32 }] },
              },
            },
          },
        },
      },
    });
    const result = successful(text);
    expect(result.artifact.metadata).toMatchObject({
      raw: "{broken",
      parse_status: "malformed",
    });
    expect(result.artifact.reference_bounds).toBe("unavailable");
    expect(result.artifact.immutable_references?.[0]).toMatchObject({
      start: 4,
      length: 32,
    });
    expect(solcArtifactSchema.parse(result.artifact)).toEqual(result.artifact);
  });

  it("retains resource-limited metadata independently of valid outer compiler JSON", () => {
    const metadata =
      '{"settings":' +
      "[".repeat(SOLC_JSON_LIMITS.depth + 1) +
      "0" +
      "]".repeat(SOLC_JSON_LIMITS.depth + 1) +
      "}";
    const text = JSON.stringify({
      contracts: {
        [selection.source_unit]: {
          C: { metadata, evm: { bytecode: { object: "6000" } } },
        },
      },
    });
    const result = successful(text);
    expect(result.artifact.metadata).toMatchObject({
      raw: metadata,
      parse_status: "resource-limited",
      compiler_version: null,
      settings_json: null,
    });
    const sourceRange = result.artifact.metadata.source_range;
    expect(sourceRange && text.slice(sourceRange.start, sourceRange.end)).toBe(
      JSON.stringify(metadata),
    );
    expect([...(result.bytes ?? [])]).toEqual([0x60, 0]);
    expect(solcArtifactSchema.parse(result.artifact)).toEqual(result.artifact);
  });

  it("retains compiler diagnostics on missing selections and malformed selected spans", () => {
    const diagnostic =
      '{"component":"general","errorCode":"2314","severity":"error","formattedMessage":"ParserError: Expected identifier"}';
    const errorOnly = select(`{"errors":[${diagnostic}],"sources":{}}`);
    if (errorOnly.ok) throw new Error("Expected compiler selection failure");
    expect(errorOnly.error.reason).toBe("selection");
    expect(errorOnly.error.compiler_diagnostics?.[0]?.raw_json).toBe(
      diagnostic,
    );
    expect(errorOnly.error.compiler_diagnostics?.[0]?.json_pointer).toBe(
      "/errors/0",
    );
    const malformed = carrier("00", {
      immutableReferences: { "1": [{ start: 0, length: 2 }] },
    }).replace(/}$/, `,"errors":[${diagnostic}]}`);
    const result = select(malformed);
    if (result.ok) throw new Error("Expected invalid span failure");
    expect(result.error.reason).toBe("format");
    expect(result.error.compiler_diagnostics?.[0]?.severity).toBe("error");
  });
});

it.each([
  "lib.sol:L",
  "/lib.sol:L",
  "./lib.sol:L",
  "@pkg/lib.sol:L",
  "_".repeat(36),
  "$" + "g".repeat(34) + "$",
])(
  "retains fixed-width legacy placeholders with opaque source prefix %s",
  (name) => {
    const placeholder = `__${name.padEnd(36, "_")}__`;
    const result = successful(carrier(placeholder));
    expect(result.bytes).toBeNull();
    expect(result.artifact.status).toBe("unlinked");
    expect(result.artifact.placeholders).toEqual([
      { start: 0, length: 20, value: placeholder },
    ]);
    expect(solcArtifactSchema.parse(result.artifact)).toEqual(result.artifact);
  },
);

it.each(["雪.sol", "é.sol", "😀.sol"])(
  "keeps UTF-8 legacy widths separate from JSON text coordinates for %s",
  (source) => {
    const name = `${source}:L`;
    const placeholder = `__${name}${"_".repeat(36 - Buffer.byteLength(name, "utf8"))}__`;
    expect(Buffer.byteLength(placeholder, "utf8")).toBe(40);
    const object = `60${placeholder}60${placeholder}00`;
    const text = carrier(object, {
      linkReferences: {
        [source]: {
          L: [
            { start: 1, length: 20 },
            { start: 22, length: 20 },
          ],
        },
      },
      immutableReferences: { "1": [{ start: 42, length: 1 }] },
    });
    const result = successful(text);
    expect(result.byteLength).toBe(43);
    expect(result.bytes).toBeNull();
    expect(result.artifact.object).toBe(object);
    expect(result.artifact.placeholders).toEqual([
      { start: 1, length: 20, value: placeholder },
      { start: 22, length: 20, value: placeholder },
    ]);
    expect(solcArtifactSchema.parse(result.artifact)).toEqual(result.artifact);
    const range = result.artifact.object_range;
    expect(range && JSON.parse(text.slice(range.start, range.end))).toBe(
      object,
    );
  },
);

describe("malformed compiler carriers", () => {
  it.each([
    '{"contracts":{},"contracts":{}}',
    '{"a":{"x":1,"x":2}}',
    '{"a":1,}',
    '{/*comment*/"a":1}',
    '{"a":1} true',
    carrier("0x60"),
    carrier("6"),
    carrier("60 ff"),
    carrier("__broken__"),
    carrier(`__$${"g".repeat(33)}$__`),
    carrier(`__$${"g".repeat(33)}\n$__`),
    carrier("6000", {
      immutableReferences: { "1": [{ start: 1, length: 2 }] },
    }),
    carrier("6000", {
      linkReferences: {
        a: { L: [{ start: 0, length: Number.MAX_SAFE_INTEGER + 1 }] },
      },
    }),
    '{"contracts":[]}',
  ])("rejects malformed carrier %s", (text) => {
    const result = select(text);
    expect(result.ok ? null : result.error.reason).toBe("format");
  });

  it("bounds wide JSON trees before AST allocation independently of byte size", () => {
    const text = `[${"0,".repeat(SOLC_JSON_LIMITS.nodes)}0]`;
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(
      SOLC_JSON_LIMITS.inputBytes,
    );
    const result = select(text);
    expect(result.ok ? null : result.error.reason).toBe("resource");
    expect(result.ok ? null : result.error.message).toContain("AST nodes");
  });

  it("rejects rounded decimal reference coordinates and excessive depth before AST allocation", () => {
    const text = carrier("00", {
      immutableReferences: { "1": [{ start: 0, length: 1 }] },
    }).replace('"start":0', '"start":9007199254740991.1');
    const result = select(text);
    expect(result.ok ? null : result.error.reason).toBe("format");
    const deep = select("[".repeat(10000) + "0" + "]".repeat(10000));
    expect(deep.ok ? null : deep.error.reason).toBe("resource");
    const invalidUtf8 = selectSolcArtifact(Uint8Array.of(0xff), selection);
    expect(invalidUtf8.ok ? null : invalidUtf8.error.reason).toBe("format");
    const tooLarge = selectSolcArtifact(
      new Uint8Array(4 * 1024 * 1024 + 1),
      selection,
    );
    expect(tooLarge.ok ? null : tooLarge.error.reason).toBe("resource");
  });
});

it("rejects placeholder spans without a source compiler object", () => {
  const result = successful(carrier(undefined));
  expect(
    solcArtifactSchema.safeParse({
      ...result.artifact,
      placeholders: [
        { start: 0, length: 20, value: `__$${"a".repeat(34)}$__` },
      ],
    }).success,
  ).toBe(false);
});
