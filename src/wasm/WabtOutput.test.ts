import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseWabtOutput } from "./WabtOutput.js";
import { parseWabtWat } from "./WabtWat.js";
import { associateWasmGlue } from "./WasmGlueAdapter.js";
const golden = () =>
  readFile(
    new URL("../../tests/fixtures/wasm/objdump.txt", import.meta.url),
    "utf8",
  );
it("retains real WABT section ranges, custom section identity and original header output", async () => {
  const text = await golden();
  const headers = text.slice(0, text.indexOf("Section Details:\n"));
  expect(parseWabtOutput(text, 76, ["test"]).sections).toHaveLength(7);
  expect(parseWabtOutput(text, 76, ["test"]).headers).toBe(headers);
  expect(parseWabtOutput(text, 76, ["test"]).sections.at(-1)).toEqual({
    kind: "Custom",
    start: 64,
    end: 76,
    bytes: 12,
    description: '"test"',
  });
  expect(() => parseWabtOutput(text, 75, ["test"])).toThrow(/ranges/u);
  expect(() =>
    parseWabtOutput(text.replace("size=0x0000000c", "size=0x0000000d"), 76, [
      "test",
    ]),
  ).toThrow(/ranges/u);
  expect(() =>
    parseWabtOutput(
      text.replace("\nSection Details:\n", "unexpected\nSection Details:\n"),
      76,
      ["test"],
    ),
  ).toThrow(/Unrecognized/u);
  expect(() =>
    parseWabtOutput(
      text.replace(
        "\nSection Details:\n",
        "\nDataCount start=0x00000040 end=0x0000004c (size=0x0000000c)\nSection Details:\n",
      ),
      76,
      ["test"],
    ),
  ).toThrow(/Unrecognized/u);
});
const dataCountModuleBytes = 0x3d;
const unpaddedDataCountRow =
  "DataCount start=0x00000023 end=0x00000024 (size=0x00000001) count: 1";
const dataCountDump = [
  "",
  "module.wasm:\tfile format wasm 0x1",
  "",
  "Sections:",
  "",
  "     Type start=0x0000000a end=0x0000000e (size=0x00000004) count: 1",
  " Function start=0x00000010 end=0x00000012 (size=0x00000002) count: 1",
  "   Memory start=0x00000014 end=0x00000017 (size=0x00000003) count: 1",
  "   Export start=0x00000019 end=0x00000021 (size=0x00000008) count: 1",
  unpaddedDataCountRow,
  "     Code start=0x00000026 end=0x00000037 (size=0x00000011) count: 1",
  "     Data start=0x00000039 end=0x0000003d (size=0x00000004) count: 1",
  "",
  "Section Details:",
  "",
].join("\n");
it("accepts an unpadded DataCount row and still rejects malformed output and bad ranges", () => {
  const parsed = parseWabtOutput(dataCountDump, dataCountModuleBytes, []);
  expect(parsed.sections.map(({ kind }) => kind)).toEqual([
    "Type",
    "Function",
    "Memory",
    "Export",
    "DataCount",
    "Code",
    "Data",
  ]);
  expect(parsed.sections.find(({ kind }) => kind === "DataCount")).toEqual({
    kind: "DataCount",
    start: 0x23,
    end: 0x24,
    bytes: 1,
    description: "count: 1",
  });
  expect(parsed.headers).toContain(`\n${unpaddedDataCountRow}\n`);
  expect(() =>
    parseWabtOutput(
      dataCountDump.replace(unpaddedDataCountRow, "DataCount count: 1"),
      dataCountModuleBytes,
      [],
    ),
  ).toThrow(/Unrecognized/u);
  expect(() =>
    parseWabtOutput(
      dataCountDump.replace(unpaddedDataCountRow, "Sections:"),
      dataCountModuleBytes,
      [],
    ),
  ).toThrow(/Unrecognized/u);
  expect(() =>
    parseWabtOutput(
      dataCountDump.replace(
        unpaddedDataCountRow,
        "DataCount start=0x00000023 end=0x00000024 (size=0x00000001)count: 1",
      ),
      dataCountModuleBytes,
      [],
    ),
  ).toThrow(/Unrecognized/u);
  expect(() =>
    parseWabtOutput(
      dataCountDump.replace("(size=0x00000001)", "(size=0x00000002)"),
      dataCountModuleBytes,
      [],
    ),
  ).toThrow(/ranges/u);
  expect(() =>
    parseWabtOutput(
      dataCountDump.replace(
        "DataCount start=0x00000023 end=0x00000024 (size=0x00000001)",
        "DataCount start=0x00000020 end=0x00000021 (size=0x00000001)",
      ),
      dataCountModuleBytes,
      [],
    ),
  ).toThrow(/ranges/u);
  expect(() =>
    parseWabtOutput(dataCountDump, dataCountModuleBytes - 1, []),
  ).toThrow(/ranges/u);
  expect(() =>
    parseWabtOutput(
      dataCountDump.replace(
        "\nmodule.wasm:\tfile format wasm 0x1\n\nSections:\n\n",
        "",
      ),
      dataCountModuleBytes,
      [],
    ),
  ).toThrow(/header/u);
});
it("bounds section header bytes while accepting a five-byte size LEB", () => {
  const paddedCustomDump = [
    "",
    "module.wasm:\tfile format wasm 0x1",
    "",
    "Sections:",
    "",
    '   Custom start=0x0000000e end=0x0000000f (size=0x00000001) ""',
    "",
    "Section Details:",
    "",
    "Custom:",
    ' - name: ""',
    "",
  ].join("\n");
  expect(parseWabtOutput(paddedCustomDump, 15, [""]).sections).toMatchObject([
    { kind: "Custom", start: 14, end: 15, bytes: 1 },
  ]);

  for (const gap of [0, 1, 7]) {
    const start = 11 + gap;
    const malformed = [
      "",
      "module.wasm:\tfile format wasm 0x1",
      "",
      "Sections:",
      "",
      "     Type start=0x0000000a end=0x0000000b (size=0x00000001) count: 0",
      `   Custom start=0x${start.toString(16).padStart(8, "0")} end=0x${(start + 1).toString(16).padStart(8, "0")} (size=0x00000001) ""`,
      "",
      "Section Details:",
      "",
    ].join("\n");
    expect(() => parseWabtOutput(malformed, start + 1, [""])).toThrow(
      /ranges/u,
    );
  }
});
it.each([
  { displayed: [], decoded: ["named"] },
  { displayed: ["named"], decoded: [] },
  { displayed: ["other"], decoded: ["named"] },
])(
  "rejects module-name headers inconsistent with decoded WAT: %j",
  async ({ displayed, decoded }) => {
    const text = (await golden()).replace(
      "\n\nSections:",
      `\n${displayed.map((name) => `module name: <${name}>\n`).join("")}\nSections:`,
    );
    expect(() => parseWabtOutput(text, 76, ["test"], decoded)).toThrow(
      /header format/u,
    );
  },
);
it.each([
  '(module (@custom "name" "\\00\\06\\05name"))',
  '(module (@custom "name" "\\00\\05\\05name"))',
])("rejects incomplete decoded module-name metadata: %s", (text) => {
  expect(() => parseWabtWat(text)).toThrow(/metadata/u);
});
it("frames custom section names at their NUL-terminated objdump display", async () => {
  const text = await golden();
  expect(parseWabtOutput(text, 76, ["test\0hidden"]).sections.at(-1)).toEqual({
    kind: "Custom",
    start: 64,
    end: 76,
    bytes: 12,
    description: '"test"',
  });
  expect(() => parseWabtOutput(text, 76, ["other\0test"])).toThrow(
    /custom-section header/u,
  );
});
it("preserves leading U+FEFF as custom-name data, not a debug-name marker", () => {
  const parsed = parseWabtWat(
    '(module (@custom "\\ef\\bb\\bfsection" "payload") (@custom "\\ef\\bb\\bfname" "payload") (@custom "\\ef\\bb\\bf" "payload") (@custom "" "payload"))',
  );
  expect(parsed.customSectionNames).toEqual([
    "\uFEFFsection",
    "\uFEFFname",
    "\uFEFF",
    "",
  ]);
  expect(parsed.debugModuleNames).toEqual([]);
  expect(() => parseWabtWat('(module (@custom "\\ff" "payload"))')).toThrow();
});
it("extracts escaped WAT import/export forms while retaining multiline producer text", async () => {
  const text = await readFile(
    new URL("../../tests/fixtures/wasm/decoded.wat", import.meta.url),
    "utf8",
  );
  expect(parseWabtWat(text)).toEqual({
    imports: ['(import "env" "foo" (func (;0;) (type 0)))'],
    exports: ['(export "memory" (memory 0))', '(export "run" (func 1))'],
    customSectionNames: ["test"],
    debugModuleNames: [],
  });
  expect(
    parseWabtWat(
      '(module (import "a.b" "c\\0aline" (func)) (export "fake\\22Export[1]:" (func 0)))',
    ),
  ).toEqual({
    imports: ['(import "a.b" "c\\0aline" (func))'],
    exports: ['(export "fake\\22Export[1]:" (func 0))'],
    customSectionNames: [],
    debugModuleNames: [],
  });
  expect(
    parseWabtWat(
      '(module (; nested (; comment ;) ;) ;; comment\n (export "x" (func 0)))',
    ).exports,
  ).toEqual(['(export "x" (func 0))']);
  expect(() => parseWabtWat('(module (export "unfinished"')).toThrow(
    /Incomplete/u,
  );
  expect(() => parseWabtWat("(module) unexpected")).toThrow(/Unexpected/u);
});
it("keeps exact local, ambiguous URL, computed and unparseable glue distinct", () => {
  const candidates = ["/app/module.wasm", "/other/module.wasm"];
  const result = associateWasmGlue(
    'fetch("./module.wasm"); new URL("https://example.com/module.wasm?x=1", import.meta.url); fetch(`module.wasm`); fetch(name + ".wasm");',
    "/app/glue.js",
    candidates,
  );
  expect(result.parse_status).toBe("complete");
  expect(result.references).toMatchObject([
    {
      value: "./module.wasm",
      association: "local-path-candidate",
      candidate_paths: ["/app/module.wasm"],
    },
    {
      value: "https://example.com/module.wasm?x=1",
      association: "basename-candidates",
      candidate_paths: candidates,
    },
    { value: "module.wasm", association: "local-path-candidate" },
    { value: ".wasm", association: "unresolved" },
  ]);
  expect(associateWasmGlue("function (", "/glue.js", candidates)).toEqual({
    parse_status: "failed",
    references: [],
  });
});
