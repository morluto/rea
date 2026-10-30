import { expect, it } from "vitest";

import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { parsePlistXmlSource } from "../../native/parsers/plist.js";
import { preflightPropertyListDecode } from "./PropertyListDecodeBudget.js";

const xmlPlist = (body: string): Buffer =>
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n${body}</plist>\n`,
  );

it("refuses an XML plist whose DOM exceeds the native decode budget", () => {
  // Real decode peaks near 110 MiB: about 1,100 bytes per element and text node.
  const parsed = parsePlistXmlSource(
    xmlPlist(`<array>\n${"<true/>\n".repeat(100_000)}</array>\n`),
  );
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error("Expected a decode budget refusal");
  expect(parsed.error).toBeInstanceOf(AnalysisResourceConstraintError);
  expect(parsed.error.message).toContain("native plist decode budget");
});

it("admits an ordinary pretty-printed XML plist", () => {
  const entry = (index: number) =>
    `\t<dict>\n${Array.from(
      { length: 5 },
      (_, key) =>
        `\t\t<key>Key${String(key)}</key>\n\t\t<real>${String(index)}.5</real>\n`,
    ).join("")}\t</dict>\n`;
  const parsed = parsePlistXmlSource(
    xmlPlist(
      `<array>\n${Array.from({ length: 2000 }, (_, index) => entry(index)).join("")}</array>\n`,
    ),
  );
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.value).toHaveLength(2000);
});

it.each([
  ["elements", "<true/>", 1280],
  ["text after elements", "<true/>\n", 1280 + 384],
  ["comments", "<!---->", 384],
  ["CDATA sections", "<string><![CDATA[a]]></string>", 1280 + 384],
])(
  "charges %s for the DOM nodes the decoder builds",
  (_name, item, perItem) => {
    const count = 1000;
    const bytes = xmlPlist(`<array>${item.repeat(count)}</array>`);
    const { estimatedBytes } = preflightPropertyListDecode(
      bytes,
      Number.MAX_SAFE_INTEGER,
    );
    expect(estimatedBytes).toBeGreaterThanOrEqual(
      bytes.length * 4 + count * perItem,
    );
  },
);
