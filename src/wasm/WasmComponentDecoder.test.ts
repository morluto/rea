import { describe, expect, it } from "vitest";

import { decodeWasmComponent } from "./WasmComponentDecoder.js";
import {
  component,
  coreModule,
  externName,
  gatedFeatureComponent,
  name,
  nestedComponent,
  representativeComponent,
  section,
  u32,
  vec,
  vecOf,
  withPreamble,
} from "./WasmComponentBinary.fixture.js";
import {
  isWasmComponentFormatFailure,
  MAX_DECODED_ITEMS,
  MAX_INLINE_RESULT_BYTES,
} from "./WasmComponentReader.js";

const failureOf = async (bytes: Uint8Array) => {
  try {
    await decodeWasmComponent(bytes);
  } catch (cause: unknown) {
    if (isWasmComponentFormatFailure(cause)) return cause;
    throw cause;
  }
  throw new Error("Expected a component format failure");
};

const decodeRepresentative = async () => {
  const bytes = representativeComponent();
  const decoded = await decodeWasmComponent(bytes);
  const [root] = decoded.components;
  if (root === undefined) throw new Error("Missing root component");
  return { bytes, decoded, root };
};

describe("decodeWasmComponent index spaces", () => {
  it("assigns definition indices across interleaved sections", async () => {
    const { bytes, decoded, root } = await decodeRepresentative();
    expect(decoded.notDecoded).toEqual([]);
    expect(root).toMatchObject({
      id: 0,
      parent: null,
      index: null,
      range: { start: 0, end: bytes.length },
    });
    expect(
      root.imports.map(({ name, defines }) => ({ name, defines })),
    ).toEqual([
      { name: "log", defines: { sort: "func", index: 0 } },
      { name: "wasi:fs/types@0.2.0", defines: { sort: "instance", index: 0 } },
    ]);
    expect(root.exports).toEqual([
      expect.objectContaining({
        name: "run",
        target: { sort: "func", index: 1 },
        type: null,
        defines: { sort: "func", index: 3 },
      }),
    ]);
    expect(root.core_modules).toEqual([
      expect.objectContaining({
        index: 0,
        core_version: 1,
        interface: {
          status: "decoded",
          reason: null,
          imports: [
            { module: "host", name: "log", type: { kind: "func", type: 0 } },
          ],
          exports: [
            { name: "run", kind: "func", index: 1 },
            { name: "memory", kind: "memory", index: 0 },
          ],
        },
      }),
    ]);
    expect(root.canons.map(({ kind, defines }) => ({ kind, defines }))).toEqual(
      [
        { kind: "lower", defines: { sort: "core func", index: 0 } },
        { kind: "lift", defines: { sort: "func", index: 1 } },
        { kind: "lower", defines: { sort: "core func", index: 2 } },
      ],
    );
    expect(root.canons[2]?.options).toEqual([
      { kind: "memory", core_memory: 0 },
      { kind: "string-encoding", encoding: "utf8" },
    ]);
    const module = root.core_modules[0];
    if (module === undefined) throw new Error("Missing core module");
    expect(bytes.subarray(module.range.start, module.range.start + 8)).toEqual(
      Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
    );
  });
});

describe("decodeWasmComponent relationships", () => {
  it("traces canonical lifts and lowers through the component index spaces", async () => {
    const { decoded, root } = await decodeRepresentative();
    expect(root.lifts).toEqual([
      {
        canon: 1,
        func: 1,
        core_func: 1,
        type: 1,
        core_source: {
          core_instance: 1,
          name: "run",
          core_module: 0,
          declared_by_module: true,
        },
        exported_as: ["run"],
      },
    ]);
    expect(root.lowers).toEqual([
      {
        canon: 0,
        func: 0,
        core_func: 0,
        component_source: { kind: "import", name: "log" },
        satisfies: [
          {
            core_instance: 1,
            core_module: 0,
            import_module: "host",
            import_name: "log",
            declared_by_module: true,
          },
        ],
      },
      {
        canon: 2,
        func: 2,
        core_func: 2,
        component_source: {
          kind: "instance-export",
          instance: 0,
          name: "[method]file.name",
          instance_import: "wasi:fs/types@0.2.0",
        },
        satisfies: [],
      },
    ]);
    expect(root.names).toMatchObject({
      status: "decoded",
      component: "demo",
      sorts: [
        {
          sort: "func",
          names: [
            { index: 0, name: "log" },
            { index: 1, name: "run" },
          ],
        },
      ],
    });
    expect(root.types[2]?.type).toEqual({ kind: "instance", scope: 0 });
    expect(decoded.typeScopes).toEqual([
      expect.objectContaining({
        scope: 0,
        kind: "instance",
        declarations: [
          expect.objectContaining({
            kind: "export",
            name: "file",
            type: { sort: "type", bound: { kind: "sub-resource" } },
          }),
          expect.objectContaining({
            kind: "type",
            type: { kind: "borrow", resource: 0 },
          }),
          expect.objectContaining({
            kind: "type",
            type: {
              kind: "func",
              async: false,
              params: [{ name: "self", type: { type: 1 } }],
              result: "string",
            },
          }),
          expect.objectContaining({
            kind: "export",
            name: "[method]file.name",
            type: { sort: "func", type: 2 },
          }),
        ],
      }),
    ]);
  });
});

describe("decodeWasmComponent gated and nested encodings", () => {
  it("reports gated encodings it decodes", async () => {
    const decoded = await decodeWasmComponent(gatedFeatureComponent());
    const [root] = decoded.components;
    expect(decoded.features).toEqual([
      "async",
      "error-context",
      "fixed-size-list",
      "map",
      "version-suffix",
    ]);
    expect(root?.types.map(({ type }) => type)).toEqual([
      { kind: "stream", element: "u8" },
      { kind: "map", key: "string", value: "u32" },
      { kind: "list", element: "u8", length: 4 },
      {
        kind: "func",
        async: true,
        params: [{ name: "s", type: { type: 0 } }],
        result: "error-context",
      },
    ]);
    expect(root?.imports[0]?.attributes).toEqual([
      { kind: "version-suffix", suffix: "-rc1" },
    ]);
    expect(root?.canons.map(({ kind }) => kind)).toEqual([
      "task.return",
      "stream.new",
    ]);
    expect(root?.canons[0]).toMatchObject({
      result: "u32",
      options: [{ kind: "async" }],
    });
  });

  it("decodes nested components and stops at the nesting bound", async () => {
    const inner = component(section(7, vec([0x40, ...vec(), 0x01, 0x00])));
    const decoded = await decodeWasmComponent(nestedComponent(2, inner));
    expect(
      decoded.components.map(({ id, parent, index }) => ({
        id,
        parent,
        index,
      })),
    ).toEqual([
      { id: 0, parent: null, index: null },
      { id: 1, parent: 0, index: 0 },
      { id: 2, parent: 1, index: 0 },
    ]);
    expect(decoded.components[2]?.types).toHaveLength(1);

    const deep = await decodeWasmComponent(nestedComponent(16, inner));
    expect(deep.components).toHaveLength(16);
    expect(deep.notDecoded).toEqual([
      expect.objectContaining({
        component: 15,
        reason: expect.stringContaining("Component nesting exceeds 16 levels"),
      }),
    ]);
  });
});

describe("decodeWasmComponent partial coverage", () => {
  it("records unsupported constructs and keeps later indices unknown", async () => {
    const decoded = await decodeWasmComponent(
      component(
        section(7, vec([0x40, ...vec(), 0x01, 0x00])),
        section(10, vec([...externName("first"), 0x01, ...u32(0)])),
        section(13, [0x01, 0x02]),
        section(10, vec([...externName("second"), 0x01, ...u32(0)])),
        section(3, vec([0x5f, ...vec()])),
      ),
    );
    const [root] = decoded.components;
    expect(root?.sections.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 7, status: "decoded" },
      { id: 10, status: "decoded" },
      { id: 13, status: "not_decoded" },
      { id: 10, status: "decoded" },
      { id: 3, status: "not_decoded" },
    ]);
    expect(root?.imports.map(({ defines }) => defines)).toEqual([
      { sort: "func", index: 0 },
      { sort: "func", index: null },
    ]);
    expect(decoded.notDecoded.map(({ reason }) => reason)).toEqual([
      expect.stringContaining("Unknown section id 13"),
      expect.stringContaining("Core type opcode 0x5f"),
    ]);
  });

  it("keeps sources defined before a later undecoded section", async () => {
    const decoded = await decodeWasmComponent(
      component(
        section(10, vec([...externName("f"), 0x01, ...u32(0)])),
        section(8, vec([0x01, 0x00, ...u32(0), ...vec()])),
        section(13, [0x01]),
        section(8, vec([0x01, 0x00, ...u32(0), ...vec()])),
      ),
    );
    const lowers = decoded.components[0]?.lowers;
    expect(lowers?.map(({ core_func }) => core_func)).toEqual([0, null]);
    expect(lowers?.map(({ component_source }) => component_source)).toEqual([
      { kind: "import", name: "f" },
      { kind: "import", name: "f" },
    ]);
  });

  it("keeps decoding when the name section is invalid or a module is not core", async () => {
    const decoded = await decodeWasmComponent(
      component(
        section(1, [0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]),
        section(0, [...name("component-name"), ...section(0, [0x05, 0x61])]),
        section(1, coreModule(section(2, [0x01, 0x7f]))),
        section(1, [0x01, 0x02]),
      ),
    );
    const [root] = decoded.components;
    expect(root?.names).toMatchObject({
      status: "invalid",
      reason: expect.stringContaining("component name"),
    });
    expect(
      root?.core_modules.map(({ index, core_version, interface: face }) => ({
        index,
        core_version,
        status: face.status,
      })),
    ).toEqual([
      { index: 0, core_version: null, status: "not_decoded" },
      { index: 1, core_version: 1, status: "not_decoded" },
      { index: 2, core_version: null, status: "not_decoded" },
    ]);
    expect(
      decoded.notDecoded.map(({ kind, reason }) => ({ kind, reason })),
    ).toEqual([
      {
        kind: "unsupported",
        reason: expect.stringContaining("layer 1, not a core module"),
      },
      {
        kind: "malformed",
        reason: expect.stringContaining("component-name section:"),
      },
      {
        kind: "malformed",
        reason: expect.stringContaining("Embedded core module interface:"),
      },
      {
        kind: "malformed",
        reason: expect.stringContaining("no WebAssembly header"),
      },
    ]);
  });
});

describe("decodeWasmComponent resource bounds", () => {
  it("counts start results without allocating an entry per result", async () => {
    const decoded = await decodeWasmComponent(
      component(
        section(9, [0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x0f]),
        section(12, vec([0x7f, 0x01, 0x01])),
      ),
    );
    const [root] = decoded.components;
    expect(root?.start?.results).toBe(4_294_967_295);
    expect(root?.values[0]?.index).toBe(4_294_967_295);
  });

  it("traces many lifts and exports in linear time", async () => {
    const count = 20_000;
    const lifts = Array.from({ length: count }, () => [
      0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const exports = Array.from({ length: count }, (_, index) => [
      ...externName(`e${String(index)}`),
      0x01,
      0x00,
      0x00,
    ]);
    const decoded = await decodeWasmComponent(
      component(
        section(10, vec([...externName("f"), 0x01, ...u32(0)])),
        section(8, vecOf(lifts)),
        section(11, vecOf(exports)),
      ),
    );
    const [root] = decoded.components;
    expect(root?.lifts).toHaveLength(count);
    expect(
      root?.lifts.every(({ exported_as }) => exported_as.length === 0),
    ).toBe(true);
  });

  it("fails instead of materializing multiplicative lower bindings", async () => {
    const names = Array.from({ length: 400 }, (_, index) => [
      ...name(`n${String(index)}`),
      0x00,
      ...u32(0),
    ]);
    const instantiations = Array.from({ length: 400 }, () => [
      0x00,
      ...u32(0),
      ...vec([...name("a"), 0x12, ...u32(0)]),
    ]);
    // 160,000 bindings of at least 100 serialized bytes each.
    expect(400 * 400 * 100).toBeGreaterThan(MAX_INLINE_RESULT_BYTES);
    await expect(
      decodeWasmComponent(
        component(
          section(10, vec([...externName("f"), 0x01, ...u32(0)])),
          section(8, vec([0x01, 0x00, ...u32(0), ...vec()])),
          section(2, vecOf([[0x01, ...vecOf(names)], ...instantiations])),
        ),
      ),
    ).rejects.toMatchObject({
      failure: { kind: "limit", limit: { name: "output-bytes" } },
    });
  });

  it("stops tracing before a long name repeated by every lower outgrows the output", async () => {
    const lowers = Array.from({ length: 1_000 }, () => [
      0x01,
      0x00,
      ...u32(0),
      ...vec(),
    ]);
    await expect(
      decodeWasmComponent(
        component(
          section(
            10,
            vec([...externName("f".repeat(1 << 20)), 0x01, ...u32(0)]),
          ),
          section(8, vecOf(lowers)),
        ),
      ),
    ).rejects.toMatchObject({
      failure: {
        kind: "limit",
        limit: { name: "output-bytes", maximum: MAX_INLINE_RESULT_BYTES },
      },
    });
  });

  it("charges vector entries before decoding them", async () => {
    const count = MAX_DECODED_ITEMS + 1;
    await expect(
      decodeWasmComponent(
        component(
          section(7, [
            ...u32(count),
            ...Array.from({ length: count }, () => 0x7f),
          ]),
        ),
      ),
    ).rejects.toMatchObject({
      failure: {
        kind: "limit",
        limit: { name: "decoded-items", maximum: MAX_DECODED_ITEMS },
      },
    });
  });

  it("decodes a core module with 150,000 exports", async () => {
    const exports = Array.from({ length: 150_000 }, () => [
      ...name("e"),
      0x00,
      0x00,
    ]);
    const decoded = await decodeWasmComponent(
      component(section(1, coreModule(section(7, vecOf(exports))))),
    );
    expect(decoded.components[0]?.core_modules[0]?.interface).toMatchObject({
      status: "decoded",
    });
    expect(
      decoded.components[0]?.core_modules[0]?.interface.exports,
    ).toHaveLength(150_000);
  });
});

describe("decodeWasmComponent relationship resolution", () => {
  it("binds a lowered function re-exported through an inline-export alias", async () => {
    const decoded = await decodeWasmComponent(
      component(
        section(
          1,
          coreModule(
            section(2, vec([...name("env"), ...name("y"), 0x00, 0x00])),
          ),
        ),
        section(10, vec([...externName("f"), 0x01, ...u32(0)])),
        section(8, vec([0x01, 0x00, ...u32(0), ...vec()])),
        section(2, vec([0x01, ...vec([...name("x"), 0x00, ...u32(0)])])),
        section(6, vec([0x00, 0x00, 0x01, ...u32(0), ...name("x")])),
        section(
          2,
          vec(
            [0x01, ...vec([...name("y"), 0x00, ...u32(1)])],
            [0x00, ...u32(0), ...vec([...name("env"), 0x12, ...u32(1)])],
          ),
        ),
      ),
    );
    expect(decoded.components[0]?.lowers[0]?.satisfies).toEqual([
      {
        core_instance: 2,
        core_module: 0,
        import_module: "env",
        import_name: "y",
        declared_by_module: true,
      },
    ]);
  });

  it("traces a lowered import re-exported through a component inline-export instance", async () => {
    const decoded = await decodeWasmComponent(
      component(
        section(10, vec([...externName("f"), 0x01, ...u32(0)])),
        section(5, vec([0x01, ...vec([...externName("g"), 0x01, ...u32(0)])])),
        section(6, vec([0x01, 0x00, ...u32(0), ...name("g")])),
        section(8, vec([0x01, 0x00, ...u32(1), ...vec()])),
      ),
    );
    expect(decoded.components[0]?.lowers[0]).toMatchObject({
      func: 1,
      component_source: { kind: "import", name: "f" },
    });
  });

  it("follows export chains longer than any fixed hop limit", async () => {
    const chain = Array.from({ length: 100 }, (_, index) => [
      ...externName(`e${String(index)}`),
      0x01,
      ...u32(index),
      0x00,
    ]);
    const decoded = await decodeWasmComponent(
      component(
        section(10, vec([...externName("f"), 0x01, ...u32(0)])),
        section(11, vecOf(chain)),
        section(8, vec([0x01, 0x00, ...u32(100), ...vec()])),
      ),
    );
    expect(decoded.components[0]?.lowers[0]?.component_source).toEqual({
      kind: "import",
      name: "f",
    });
  });
});

describe("decodeWasmComponent name and scope fidelity", () => {
  it("keeps a leading U+FEFF in length-prefixed names", async () => {
    const decoded = await decodeWasmComponent(
      component(
        section(
          10,
          vec(
            [...externName("\uFEFFrun"), 0x01, ...u32(0)],
            [...externName("run"), 0x01, ...u32(0)],
          ),
        ),
      ),
    );
    expect(decoded.components[0]?.imports.map(({ name }) => name)).toEqual([
      "\uFEFFrun",
      "run",
    ]);
  });

  it("drops the scopes of a type that fails partway", async () => {
    const decoded = await decodeWasmComponent(
      component(section(7, [0x01, 0x42, 0x02, 0x01, 0x7f, 0xff])),
    );
    expect(decoded.typeScopes).toEqual([]);
    expect(decoded.components[0]?.types).toEqual([]);
    expect(decoded.notDecoded).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining("Unknown type declaration 0xff"),
      }),
    ]);
  });
});

describe("decodeWasmComponent rejections", () => {
  it.each([
    [
      "a section extending past the file",
      component([0x07, 0x05, 0x00]),
      "section extends past its enclosing range",
    ],
    [
      "an overlong LEB128 count",
      component(section(7, [0x80, 0x80, 0x80, 0x80, 0x80, 0x00])),
      "Invalid u32 LEB128",
    ],
    [
      "invalid UTF-8 in an import name",
      component(section(10, vec([0x00, 0x01, 0xff, 0x01, 0x00]))),
      "Invalid UTF-8 in extern name",
    ],
    [
      "trailing bytes in a section",
      component(section(7, [...vec([0x7f]), 0x00])),
      "Unexpected trailing bytes in types section",
    ],
    ["a truncated preamble", Uint8Array.from([0x00, 0x61, 0x73]), "Truncated"],
  ])("fails closed on %s", async (_label, bytes, message) => {
    const failure = await failureOf(bytes);
    expect(failure.kind).toBe("malformed");
    expect(failure.message).toContain(message);
  });

  it.each([
    [
      "a core module",
      Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
      "use inspect_wasm_artifact",
    ],
    [
      "an older component version",
      withPreamble(representativeComponent(), 0x0c, 0x01),
      "version 0xc layer 0x1 is not admitted",
    ],
    [
      "a non-WebAssembly file",
      Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
      "missing",
    ],
  ])("rejects %s before decoding", async (_label, bytes, message) => {
    const failure = await failureOf(bytes);
    expect(failure.kind).toBe("unsupported");
    expect(failure.message).toContain(message);
  });

  it("stops before decoding when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      decodeWasmComponent(representativeComponent(), controller.signal),
    ).rejects.toThrow();
  });
});
