import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { parseWabtHeaders } from "./WabtOutput.js";
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
  expect(parseWabtHeaders(headers, 76)).toHaveLength(7);
  expect(parseWabtHeaders(headers, 76).at(-1)).toEqual({
    kind: "Custom",
    start: 64,
    end: 76,
    bytes: 12,
    description: '"test"',
  });
  expect(() => parseWabtHeaders(headers, 75)).toThrow(/ranges/u);
  expect(() =>
    parseWabtHeaders(headers.replace("size=0x0000000c", "size=0x0000000d"), 76),
  ).toThrow(/ranges/u);
  expect(() => parseWabtHeaders(headers + "unexpected\n", 76)).toThrow(
    /Unrecognized/u,
  );
});
it("extracts escaped WAT import/export forms while retaining multiline producer text", async () => {
  const text = await readFile(
    new URL("../../tests/fixtures/wasm/decoded.wat", import.meta.url),
    "utf8",
  );
  expect(parseWabtWat(text)).toEqual({
    imports: ['(import "env" "foo" (func (;0;) (type 0)))'],
    exports: ['(export "memory" (memory 0))', '(export "run" (func 1))'],
  });
  expect(
    parseWabtWat(
      '(module (import "a.b" "c\\0aline" (func)) (export "fake\\22Export[1]:" (func 0)))',
    ),
  ).toEqual({
    imports: ['(import "a.b" "c\\0aline" (func))'],
    exports: ['(export "fake\\22Export[1]:" (func 0))'],
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
