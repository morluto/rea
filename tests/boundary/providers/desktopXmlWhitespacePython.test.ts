import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import {
  PYTHON_HELPERS,
  PYTHON_IMPORTS,
} from "../../../src/domain/desktop/appExportPython.js";
import { xmlView } from "../../../src/domain/desktop/stateFormats.js";

/** Execute the unmodified generated XML reader with its standard-library imports. */
const pythonViews = (texts: readonly string[]) => {
  const imports = PYTHON_IMPORTS.split("\n")
    .filter((line) => !line.includes("agentenv_protocol"))
    .join("\n");
  return JSON.parse(
    execFileSync(
      "python3",
      [
        "-I",
        "-B",
        "-c",
        `${imports}${PYTHON_HELPERS}\nprint(json.dumps([_xml_view(text) for text in json.load(sys.stdin)]))`,
      ],
      { input: JSON.stringify(texts), encoding: "utf8" },
    ),
  );
};

it.each(["\u0085", "\ufeff"])(
  "matches REA's formatting decision for %j between elements",
  (text) => {
    const xml = `<prefs><entry/>${text}</prefs>`;
    expect(pythonViews([xml])).toEqual([xmlView(xml)]);
  },
);

it("matches the ECMAScript whitespace set for XML-valid characters and preserves other text", () => {
  const characters =
    "\t\n\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\u0085\u180e\u200b";
  const texts = [...characters].map((text) => `<prefs><entry/>${text}</prefs>`);
  expect(pythonViews(texts)).toEqual(texts.map(xmlView));
});

it("keeps leaf text and xml:space-preserved text, with the original parsing refusals", () => {
  const texts = [
    "<prefs><entry>\ufeff</entry></prefs>",
    "<prefs><entry>\u0085</entry></prefs>",
    '<prefs xml:space="preserve"><entry/>\ufeff</prefs>',
    '<prefs xml:space="preserve"><entry/>\u0085</prefs>',
  ];
  const actual = pythonViews(texts) as { root: { children: unknown[] } }[];
  const expected = texts.map(xmlView) as { root: { children: unknown[] } }[];
  expect(actual.map((view) => view.root.children)).toEqual(
    expected.map((view) => view.root.children),
  );
  expect(pythonViews(["<!DOCTYPE prefs><prefs/>", "<p:prefs/>"])).toEqual([
    null,
    null,
  ]);
});
