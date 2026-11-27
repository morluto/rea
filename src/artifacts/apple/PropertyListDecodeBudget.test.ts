import { expect, it, onTestFinished, vi } from "vitest";

import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import {
  parsePlistXml,
  parsePlistXmlSource,
} from "../../native/parsers/plist.js";
import { preflightPropertyListDecode } from "../../domain/apple/propertyListDecodeBudget.js";

const xmlPlist = (body: string): Buffer =>
  Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n${body}</plist>\n`,
  );

it("refuses an XML plist whose DOM exceeds the native decode budget and honors custom max_decoded_bytes", () => {
  // Real decode peaks near 110 MiB: about 1,100 bytes per element and text node.
  const parsed = parsePlistXmlSource(
    xmlPlist(`<array>\n${"<true/>\n".repeat(100_000)}</array>\n`),
  );
  if (parsed.ok) throw new Error("Expected a decode budget refusal");
  if (!(parsed.error instanceof AnalysisResourceConstraintError))
    throw new Error("Expected AnalysisResourceConstraintError");
  expect(parsed.error.message).toContain("native plist decode budget");
  expect(projectAnalysisError(parsed.error)).toMatchObject({
    code: "resource_constraint",
    details: {
      limit: {
        control_kind: "parameter",
        parameter: "max_decoded_bytes",
        effective_value: 64 * 1024 * 1024,
        unit: "bytes",
        minimum: 1,
        maximum: 64 * 1024 * 1024,
        default_value: 64 * 1024 * 1024,
        applies_at: "next_call",
      },
      refusal: {
        kind: "adjustable_budget",
        operation: "inspect_plist",
        control: "max_decoded_bytes",
      },
    },
  });

  const small = xmlPlist(`<array>${"<true/>".repeat(20)}</array>`);
  const refusedSmall = parsePlistXmlSource(small, 1024);
  if (refusedSmall.ok) throw new Error("Expected custom decode budget refusal");
  if (!(refusedSmall.error instanceof AnalysisResourceConstraintError))
    throw new Error("Expected AnalysisResourceConstraintError");
  expect(projectAnalysisError(refusedSmall.error).details?.limit).toMatchObject(
    {
      parameter: "max_decoded_bytes",
      effective_value: 1024,
    },
  );
  expect(parsePlistXmlSource(small, 128 * 1024).ok).toBe(true);

  const dtdSource =
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist [ <!ENTITY x "a"> ]>\n<plist version="1.0"><string>&x;</string></plist>\n';
  const dtdFixtures = [
    Buffer.from(dtdSource, "utf8"),
    Buffer.from(
      `\uFEFF${dtdSource.replace('encoding="UTF-8"', 'encoding="UTF-16"')}`,
      "utf16le",
    ),
    Buffer.from(
      `\uFEFF${dtdSource.replace('encoding="UTF-8"', 'encoding="UTF-16"')}`,
      "utf16le",
    ).swap16(),
  ];
  for (const dtd of dtdFixtures) {
    for (const budget of [1, 256, 64 * 1024 * 1024]) {
      const dtdRefused = parsePlistXmlSource(dtd, budget);
      if (dtdRefused.ok) throw new Error("Expected XML internal DTD refusal");
      if (!(dtdRefused.error instanceof AnalysisResourceConstraintError))
        throw new Error("Expected AnalysisResourceConstraintError");
      expect(dtdRefused.error.message).not.toContain("decode budget");
      const dtdProjected = projectAnalysisError(dtdRefused.error);
      expect(dtdProjected).toMatchObject({
        code: "resource_constraint",
        details: {
          reported_limits: {
            boundary: "plist-internal-dtd",
            maximum: 0,
          },
          refusal: {
            kind: "fixed_ceiling",
            operation: "inspect_plist",
          },
        },
      });
      expect(dtdProjected.details).not.toHaveProperty("limit");
    }
  }

  // Unsupported XML encodings must fail encoding detection before byte-budget preflight.
  const latin1 = Buffer.from(
    `<?xml version="1.0" encoding="ISO-8859-1"?><plist version="1.0"><string>${"a".repeat(2048)}</string></plist>`,
    "latin1",
  );
  const latin1Result = parsePlistXmlSource(latin1, 64);
  expect(latin1Result.ok).toBe(false);
  if (!latin1Result.ok) {
    expect(latin1Result.error.name).toBe("XmlPlistTextDecodeError");
  }

  // Pre-decode lower bound refuses oversized UTF-8 XML before string allocation without claiming a sufficient required_value.
  const tinyXml = Buffer.from("<plist><string>x</string></plist>");
  const tinyRefused = parsePlistXmlSource(tinyXml, 1);
  if (tinyRefused.ok)
    throw new Error("Expected pre-decode byte budget refusal");
  if (!(tinyRefused.error instanceof AnalysisResourceConstraintError))
    throw new Error("Expected AnalysisResourceConstraintError");
  const tinyProjected = projectAnalysisError(tinyRefused.error);
  expect(tinyProjected.details?.limit).toMatchObject({
    parameter: "max_decoded_bytes",
    effective_value: 1,
  });
  expect(tinyProjected.details?.limit).not.toHaveProperty("required_value");
  expect(tinyProjected.details?.refusal).not.toHaveProperty("required_value");
  expect(tinyProjected.details?.reported_limits).toMatchObject({
    boundary: "plist-decode-bytes",
    maximum: 1,
    minimum_estimated_bytes: 44,
  });
  // The diagnostic lower bound is not sufficient for full DOM decode; a higher budget succeeds.
  expect(parsePlistXmlSource(tinyXml, 44).ok).toBe(false);
  expect(parsePlistXmlSource(tinyXml, 4096).ok).toBe(true);

  const largeUtf8 = xmlPlist(`<string>${"a".repeat(4096)}</string>`);
  const preDecodeRefused = parsePlistXmlSource(largeUtf8, 64);
  if (preDecodeRefused.ok)
    throw new Error("Expected pre-decode byte budget refusal");
  if (!(preDecodeRefused.error instanceof AnalysisResourceConstraintError))
    throw new Error("Expected AnalysisResourceConstraintError");
  const preDecodeProjected = projectAnalysisError(preDecodeRefused.error);
  expect(preDecodeProjected.details?.limit).toMatchObject({
    parameter: "max_decoded_bytes",
    effective_value: 64,
  });
  expect(preDecodeProjected.details?.limit).not.toHaveProperty(
    "required_value",
  );
  expect(preDecodeProjected.details?.reported_limits).toMatchObject({
    boundary: "plist-decode-bytes",
    maximum: 64,
    minimum_estimated_bytes: expect.any(Number),
  });

  // OpenStep payloads passed to parsePlistXml bypass XML-only preflight.
  expect(
    parsePlistXml('{ "doc" = "<!DOCTYPE foo [ <!ENTITY x \\"y\\"> ]>"; }', 1024)
      .ok,
  ).toBe(true);

  const convertedRefused = parsePlistXml(small.toString("utf8"), 1024);
  if (convertedRefused.ok)
    throw new Error("Expected converted XML decode budget refusal");
  if (!(convertedRefused.error instanceof AnalysisResourceConstraintError))
    throw new Error("Expected AnalysisResourceConstraintError");
  expect(
    projectAnalysisError(convertedRefused.error).details?.limit,
  ).toMatchObject({
    parameter: "max_decoded_bytes",
    effective_value: 1024,
  });
  expect(parsePlistXml(small.toString("utf8"), 128 * 1024).ok).toBe(true);
});

// Saxes accepts any XML NameStartChar, and the DOM holds every element
// before the plist decoder rejects an unknown tag.
it.each(["é", "_", ":", "雪", "\u{1d4b3}"])(
  "refuses 100,000 elements whose names start with %s before building the DOM",
  (name) => {
    const parsed = parsePlistXmlSource(
      xmlPlist(`<array>${`<${name}/>`.repeat(100_000)}</array>`),
    );
    if (parsed.ok) throw new Error("Expected a decode budget refusal");
    expect(parsed.error).toBeInstanceOf(AnalysisResourceConstraintError);
  },
);

it("refuses text whose entity references exceed the decode budget", () => {
  const parsed = parsePlistXmlSource(
    xmlPlist(`<array><string>${"&amp;".repeat(1_000_000)}</string></array>`),
  );
  if (parsed.ok) throw new Error("Expected a decode budget refusal");
  expect(parsed.error).toBeInstanceOf(AnalysisResourceConstraintError);
});

// Opaque sections hold literal ampersands, not references the parser expands.
it.each([
  ["a CDATA string", `<string><![CDATA[${"&".repeat(1_000_000)}]]></string>`],
  ["a comment", `<!--${"&".repeat(1_000_000)}--><true/>`],
])("admits literal ampersands in %s", (_name, value) => {
  const parsed = parsePlistXmlSource(xmlPlist(`<array>${value}</array>`));
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.value).toEqual([
    value.startsWith("<string>") ? "&".repeat(1_000_000) : true,
  ]);
});

it("charges references only in text and attribute values", () => {
  const mixed =
    '<array><string a="&amp;">&lt;<![CDATA[&&&]]>&gt;</string><?pi &?></array>';
  const estimate = (body: string) =>
    preflightPropertyListDecode(xmlPlist(body), Number.MAX_SAFE_INTEGER)
      .estimatedBytes;
  // Same length and nodes without any "&": only the three references differ.
  expect(estimate(mixed) - estimate(mixed.replaceAll("&", "x"))).toBe(3 * 64);
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
  ["non-ASCII elements", "<é/>", 1280],
  ["attributes", '<true a="x>y" b="z"/>', 1280 + 2 * 384],
  ["references", "<string>&amp;&#x41;</string>", 1280 + 384 + 2 * 64],
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

it("scans oversized XML declarations from bytes without TextDecoder allocation and reuses inspection on decode", () => {
  const decodeSpy = vi.spyOn(TextDecoder.prototype, "decode");
  onTestFinished(() => decodeSpy.mockRestore());

  const padding = " ".repeat(4 * 1024 * 1024);
  const paddedXml = Buffer.from(
    `<?xml version="1.0"${padding} encoding="UTF-8"?><plist><string>x</string></plist>`,
  );
  const budgetRefused = parsePlistXmlSource(paddedXml, 1);
  if (budgetRefused.ok) throw new Error("Expected decode budget refusal");
  if (!(budgetRefused.error instanceof AnalysisResourceConstraintError))
    throw new Error("Expected AnalysisResourceConstraintError");
  expect(
    projectAnalysisError(budgetRefused.error).details?.limit,
  ).toMatchObject({
    parameter: "max_decoded_bytes",
    effective_value: 1,
  });
  expect(
    projectAnalysisError(budgetRefused.error).details?.limit,
  ).not.toHaveProperty("required_value");
  expect(decodeSpy).toHaveBeenCalledTimes(0);

  const paddedDtd = Buffer.from(
    `<?xml version="1.0"${padding} encoding="UTF-8"?>\n<!DOCTYPE plist [ <!ENTITY x "a"> ]>\n<plist><string>&x;</string></plist>`,
  );
  const dtdRefused = parsePlistXmlSource(paddedDtd, 1);
  if (dtdRefused.ok) throw new Error("Expected XML internal DTD refusal");
  if (!(dtdRefused.error instanceof AnalysisResourceConstraintError))
    throw new Error("Expected AnalysisResourceConstraintError");
  expect(projectAnalysisError(dtdRefused.error).details?.refusal).toMatchObject(
    {
      kind: "fixed_ceiling",
      operation: "inspect_plist",
    },
  );
  expect(decodeSpy).toHaveBeenCalledTimes(0);

  const okParsed = parsePlistXmlSource(xmlPlist("<string>ok</string>"));
  expect(okParsed.ok).toBe(true);
  expect(decodeSpy).toHaveBeenCalledTimes(1);
});
