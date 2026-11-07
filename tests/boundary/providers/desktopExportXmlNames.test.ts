import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
} from "../../../src/domain/desktop/appExportPython.js";
import { xmlView } from "../../../src/domain/desktop/stateFormats.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const valid = [
  "<𐀀>done</𐀀>",
  "<Ϳ>done</Ϳ>",
  '<r 𐀀="done"/>',
  '<𐀀:r xmlns:𐀀="urn:test">done</𐀀:r>',
  '<r xmlns:p="urn:test"><p:𐀀>done</p:𐀀></r>',
  "<r‿>done</r‿>",
  '<!DOCTYPE 𐀀 SYSTEM "urn:literal:_u10000_"><𐀀>done</𐀀>',
  "<?𐀀 data?><r>done</r>",
  '<𐀀 a="&lt;𐀀&gt;">literal _u10000_ &amp; &#x1F600;<![CDATA[<𐀀>]]></𐀀>',
  "<r><𐀀/><_u10000_/></r>",
  '<𐀀 _u0_="literal" _u110000_="still literal"/>',
  '<r xmlns:𐀀="u" xmlns:_u10000_="v"><𐀀:n/><_u10000_:n/></r>',
  '<𐀀 xml:space="preserve"> \n<a/> </𐀀>',
  '<!DOCTYPE 𐀀 SYSTEM "file:///rea-xml-test-must-not-read.dtd"><𐀀/>',
];
const controls = [
  "<r>done</r>",
  "<é>done</é>",
  "<_u10000_>é😀</_u10000_>",
  "<𐀀></_u10000_>",
  '<𐀀 a="1" a="2"/>',
  '<𐀀 xmlns:p="u" xmlns:q="u" p:a="1" q:a="2"/>',
  "<𐀀:r/>",
  '<𐀀 xmlns:xml="urn:wrong"/>',
  '<r xmlns:𐀀="http://www.w3.org/XML/1998/namespace"/>',
  "<‿a/>",
  '<p:‿ xmlns:p="u"/>',
  "<\uE000/>",
  "<\u{F0000}/>",
  '<𐀀 a="&missing;"/>',
  '<!DOCTYPE 𐀀 SYSTEM "file:///rea-xml-test-must-not-read.dtd"><𐀀>&missing;</𐀀>',
  '<!DOCTYPE 𐀀 [<!ENTITY x "done">]><𐀀>&x;</𐀀>',
  '<?XML data?><r a="𐀀"/>',
  '<r a="<𐀀>"/>',
  "<𐀀><!--bad--comment--></𐀀>",
  "<𐀀><![CDATA[unfinished</𐀀>",
  '<𐀀 a="x"b="y"/>',
];

const runPython = async (program: string, input = ""): Promise<unknown> => {
  const root = await createTestTempDirectory("desktop-xml-names-");
  const script = join(root, "read.py");
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  await writeFile(script, `${imports}${PYTHON_HELPERS}\n${program}\n`);
  return JSON.parse(
    execFileSync(
      process.platform === "win32" ? "python" : "python3",
      ["-I", "-B", "-X", "utf8", script],
      { input, encoding: "utf8" },
    ),
  ) as unknown;
};

it.each([
  ["admitted names", valid],
  ["identity and refusal controls", controls],
] as const)("keeps native XML views for %s", async (_name, texts) => {
  const actual = (await runPython(
    "print(json.dumps([_xml_view(text) for text in json.load(sys.stdin)]))",
    JSON.stringify(texts),
  )) as unknown[];
  const expected = texts.map((text) => xmlView(text) ?? null);
  if (_name === "admitted names")
    expect(expected.every((view) => view !== null)).toBe(true);
  const mismatches = texts.flatMap((text, index) =>
    JSON.stringify(actual[index]) === JSON.stringify(expected[index])
      ? []
      : [{ text, actual: actual[index], expected: expected[index] }],
  );
  expect(mismatches).toEqual([]);
});

it("keeps XML node and depth limits with encoded names", async () => {
  const texts = [
    "<𐀀>".repeat(250) + "done" + "</𐀀>".repeat(250),
    "<r>" + "<𐀀/>".repeat(5001) + "</r>",
  ];
  const actual = await runPython(
    "print(json.dumps([_xml_view(text) for text in json.load(sys.stdin)]))",
    JSON.stringify(texts),
  );
  const expected = texts.map((text) => xmlView(text));
  expect(
    expected.every(
      (view) =>
        typeof view === "object" &&
        view !== null &&
        !Array.isArray(view) &&
        view.truncated === true,
    ),
  ).toBe(true);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
});

it("checks the compatibility byte allowance before writing expanded names", async () => {
  const actual = await runPython(`
BaseBuffer = io.StringIO
class CheckedBuffer(BaseBuffer):
    def __init__(self):
        super().__init__()
        self.bytes = 0
    def write(self, part):
        self.bytes += len(part.encode("utf-8"))
        assert self.bytes <= MAX_VIEW_BYTES, "write exceeded byte allowance"
        return super().write(part)
io.StringIO = CheckedBuffer
text = '<𐀀 a="é😀"/>'
wire = _xml_names_for_expat(text)
MAX_VIEW_BYTES = len(wire.encode("utf-8"))
assert _xml_names_for_expat(text) == wire
MAX_VIEW_BYTES -= 1
try:
    _xml_names_for_expat(text)
except ValueError as error:
    refused = str(error)
else:
    raise AssertionError("expanded names exceeded the view allowance")
print(json.dumps(refused))
`);
  expect(actual).toBe("XML name adaptation exceeds the view byte allowance");
});
