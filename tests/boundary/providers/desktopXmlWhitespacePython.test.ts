import {
  DESKTOP_VIEW_DEFAULTS,
  desktopViewPolicy,
  type DesktopViewPolicy,
} from "../../../src/domain/desktop/desktopViewPolicy.js";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import {
  renderPythonHelpers,
  PYTHON_IMPORTS,
} from "../../../src/domain/desktop/appExportPython.js";
import { xmlView } from "../../../src/domain/desktop/stateFormats.js";

/** Execute the unmodified generated XML reader with its standard-library imports. */
const pythonViews = (
  texts: readonly string[],
  policy: DesktopViewPolicy = DESKTOP_VIEW_DEFAULTS,
) => {
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
        `${imports}${renderPythonHelpers(policy)}\nprint(json.dumps([_xml_view(text) for text in json.load(sys.stdin)]))`,
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
  expect(pythonViews(texts)).toEqual(texts.map((text) => xmlView(text)));
});

it("keeps leaf text and xml:space-preserved text, reads a plain DOCTYPE as REA does, and refuses an unbound prefix", () => {
  const texts = [
    "<prefs><entry>\ufeff</entry></prefs>",
    "<prefs><entry>\u0085</entry></prefs>",
    '<prefs xml:space="preserve"><entry/>\ufeff</prefs>',
    '<prefs xml:space="preserve"><entry/>\u0085</prefs>',
  ];
  const actual = pythonViews(texts) as { root: { children: unknown[] } }[];
  const expected = texts.map((text) => xmlView(text)) as {
    root: { children: unknown[] };
  }[];
  expect(actual.map((view) => view.root.children)).toEqual(
    expected.map((view) => view.root.children),
  );
  expect(pythonViews(["<!DOCTYPE prefs><prefs/>", "<p:prefs/>"])).toEqual([
    xmlView("<!DOCTYPE prefs><prefs/>"),
    null,
  ]);
});

it("keeps the deepest admitted XML view encodable with the same Python representation", () => {
  const policy = desktopViewPolicy({ xml_depth: 494 });
  const text = `${'<a key="value">'.repeat(495)}${"</a>".repeat(495)}`;
  const expected = xmlView(text, policy);
  expect(expected).toMatchObject({ truncated: false });
  expect(pythonViews([text], policy)).toEqual([expected]);
});
