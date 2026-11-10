import { expect, it } from "vitest";
import {
  declaredDocumentType,
  isWellFormedXml,
  parseXmlDocument,
  xmlElementRanges,
} from "./xmlDocument.js";

it.each([
  '<root attr="�">😀 � &amp; &#xFFFD;</root>',
  "<root><!-- � --><![CDATA[�]]></root>",
  '<?xml version="1.0"?><root>\r\n  �\rtext</root>',
  "<!DOCTYPE root><root>�</root>",
  '<!DOCTYPE root [<!ENTITY unused "�">]><root>�</root>',
])("preserves legal Unicode and source-located DOM nodes: %j", (source) => {
  const parsed = parseXmlDocument(source, {
    doctype: "allow",
    lineEndings: "preserve",
  });
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.documentElement?.tagName).toBe("root");
  expect(parsed.value.documentElement?.lineNumber).toBeDefined();
  expect(parsed.value.documentElement?.textContent).toContain("�");
});

it.each([
  "<root attr=unquoted>�</root>",
  '<root a="x"b="�"/>',
  '<root attr="a" attr="�"/>',
  "<root><broken>�</root>",
  "<root>� & unknown</root>",
  "<root>� &missing;</root>",
  "<root>�\u0000</root>",
  "<root>�&#xD800;</root>",
  "<root>�\uFFFF</root>",
  "<root>�]]></root>",
  "<root><!-- invalid -- comment � --></root>",
  "<root>�</root><second/>",
  "<!DOCTYPE root [BOGUS]><root>�</root>",
  "<!DOCTYPE root [<!ELEMENT broken>]><root>�</root>",
  "<!DOCTYPE root SYSTEM><root>�</root>",
])("rejects malformed XML without warning-message matching: %j", (source) => {
  const parsed = parseXmlDocument(source, {
    doctype: "allow",
    lineEndings: "preserve",
  });
  if (parsed.ok) throw new Error("Expected refusal");
  expect(parsed.error.reason).toBe("malformed");
  expect(parsed.error.cause).toBeDefined();
});

it("keeps literal line endings and character-reference values distinct", () => {
  const parsed = parseXmlDocument("<root>\r\n&#13;\r�</root>", {
    doctype: "allow",
    lineEndings: "preserve",
  });
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.documentElement?.textContent).toBe("\r\n\r\r�");
});

it.each([
  '<root xmlns:p="urn:a" xmlns:q="urn:a" p:x="first" q:x="last"/>',
  '<root xmlns:p="urn:a" xmlns:q="urn:a" q:x="last" p:x="first"/>',
  '<root p:x="unbound"/>',
  '<root xmlns:xml="urn:other"/>',
  '<root xmlns:p="http://www.w3.org/2000/xmlns/"/>',
])("rejects namespace-invalid XML before DOM projection: %j", (source) => {
  expect(
    parseXmlDocument(source, { doctype: "reject", lineEndings: "preserve" }),
  ).toMatchObject({ ok: false, error: { reason: "malformed" } });
});

it.each([
  '<root xmlns:p="urn:a" xmlns:q="urn:b" p:x="first" q:x="last"/>',
  '<root xmlns="urn:a" xmlns:p="urn:a" x="first" p:x="last"/>',
  '<root xmlns:p="urn:a" p:x="first" p:y="last"/>',
])("preserves distinct expanded attribute names: %j", (source) => {
  const parsed = parseXmlDocument(source, {
    doctype: "reject",
    lineEndings: "preserve",
  });
  if (!parsed.ok) throw parsed.error;
  const attributes = parsed.value.documentElement!.attributes;
  const values = Array.from(
    { length: attributes.length },
    (_, index) => attributes.item(index)?.value,
  );
  expect(values).toContain("first");
  expect(values).toContain("last");
});

it("applies the consumer's explicit DTD policy", () => {
  const parsed = parseXmlDocument(
    '<!DOCTYPE root [<!ENTITY value "unused">]><root/>',
    { doctype: "reject", lineEndings: "preserve" },
  );
  if (parsed.ok) throw new Error("Expected unsupported DTD");
  expect(parsed.error.reason).toBe("doctype");
});

it.each([
  "<!DOCTYPE root><root/>",
  '<!DOCTYPE root SYSTEM "root[1].dtd"><root/>',
  "<!DOCTYPE root PUBLIC '-//A//DTD B//EN' 'http://example.test/b.dtd'><root/>",
])(
  "reads a DOCTYPE without an internal subset when only that is allowed: %j",
  (source) => {
    const parsed = parseXmlDocument(source, {
      doctype: "external",
      lineEndings: "normalize",
    });
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.documentElement?.tagName).toBe("root");
  },
);

it.each([
  "<!DOCTYPE root []><root/>",
  '<!DOCTYPE root SYSTEM "a.dtd" [<!ENTITY e "x">]><root/>',
  '<!DOCTYPE root PUBLIC "-//A//EN" "a]b.dtd" [ ]><root/>',
])(
  "refuses an internal subset when only an external DTD is allowed: %j",
  (source) => {
    expect(
      parseXmlDocument(source, {
        doctype: "external",
        lineEndings: "normalize",
      }),
    ).toMatchObject({ ok: false, error: { reason: "internal-subset" } });
  },
);

it.each([
  ['<!DOCTYPE root PUBLIC "-//A//DTD B//EN" "b.dtd"><root/>', true],
  ['<!DOCTYPE root SYSTEM "root[1].dtd"><root/>', true],
  ["<!DOCTYPE root\n><root/>", true],
  ["<!DOCTYPE root []><root/>", false],
  ['<!DOCTYPE root SYSTEM "a.dtd"><root>&e;</root>', false],
  ['<!DOCTYPE root PUBLIC "{bad}" "b.dtd"><root/>', false],
  ['<!DOCTYPE root PUBLIC "-//A//EN"><root/>', false],
  ["<!DOCTYPE root SYSTEM><root/>", false],
  ['<!DOCTYPE root SYSTEM "a.dtd" junk><root/>', false],
  ["<!DOCTYPEroot><root/>", false],
])(
  "tells XML by the syntax pass alone as the DOM parse does under the external policy: %j",
  (source, xml) => {
    expect(isWellFormedXml(source, { doctype: "external" })).toBe(xml);
    expect(
      parseXmlDocument(source, {
        doctype: "external",
        lineEndings: "normalize",
      }).ok,
    ).toBe(xml);
  },
);

it("reports a document type's name and identifiers as declared, the public one normalized", () => {
  const read = (source: string) => {
    const parsed = parseXmlDocument(source, {
      doctype: "external",
      lineEndings: "normalize",
    });
    if (!parsed.ok) throw parsed.error;
    return declaredDocumentType(parsed.value);
  };

  expect(
    read(
      '<!DOCTYPE abiword PUBLIC "  -//ABISOURCE//DTD\r\n AWML 1.0 Strict//EN " "http://www.abisource.com/awml.dtd"><abiword/>',
    ),
  ).toEqual({
    name: "abiword",
    publicId: "-//ABISOURCE//DTD AWML 1.0 Strict//EN",
    systemId: "http://www.abisource.com/awml.dtd",
  });
  expect(read("<!DOCTYPE a SYSTEM 'x  y'><a/>")).toEqual({
    name: "a",
    publicId: null,
    systemId: "x  y",
  });
  expect(read('<!DOCTYPE a PUBLIC "" ""><a/>')).toEqual({
    name: "a",
    publicId: "",
    systemId: "",
  });
  expect(read("<!DOCTYPE a><a/>")).toEqual({
    name: "a",
    publicId: null,
    systemId: null,
  });
  expect(read("<a/>")).toBeUndefined();
});

it("applies XML line-ending normalization only when the consumer selects it", () => {
  const parsed = parseXmlDocument('<root attr="a\r\nb">\r\nx</root>', {
    doctype: "allow",
    lineEndings: "normalize",
  });
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.documentElement?.getAttribute("attr")).toBe("a b");
  expect(parsed.value.documentElement?.textContent).toBe("\nx");
});

it("preserves Unicode separators under XML 1.0 normalization", () => {
  const parsed = parseXmlDocument(
    '<root attr="a\u0085b\u2028c\u2029d">a\r\u0085b\r\u2028c\r\n&#13;d\u2029</root>',
    { doctype: "allow", lineEndings: "normalize" },
  );
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.documentElement?.getAttribute("attr")).toBe(
    "a\u0085b\u2028c\u2029d",
  );
  expect(parsed.value.documentElement?.textContent).toBe(
    "a\n\u0085b\n\u2028c\n\rd\u2029",
  );
});

it("gives the source range of each picked element, the outermost, through line breaks and astral characters", () => {
  const source =
    '<r xmlns:n="urn:n">\r\n<!-- <x n:k="1"/> --><x n:k="1">😀<x n:k="1"/></x>\r\n<x  n:k = \'1\' /><x k="1"/></r>';
  const ranges = xmlElementRanges(
    source,
    (element) =>
      element.local === "x" && element.attribute("urn:n", "k") === "1",
    { doctype: "reject" },
  );

  if (!ranges.ok) throw ranges.error;
  expect(
    ranges.value.map(({ start, end }) => source.slice(start, end)),
  ).toEqual(['<x n:k="1">😀<x n:k="1"/></x>', "<x  n:k = '1' />"]);
  expect(
    xmlElementRanges("<r><x></r>", () => true, { doctype: "reject" }).ok,
  ).toBe(false);
});

it("selects sibling outermost matches after a deeply nested nonmatching branch", () => {
  const source = `<root>${"<n>".repeat(4000)}${"</n>".repeat(4000)}<x><x/></x><x/></root>`;
  const ranges = xmlElementRanges(source, ({ local }) => local === "x", {
    doctype: "reject",
  });
  if (!ranges.ok) throw ranges.error;
  expect(
    ranges.value.map(({ start, end }) => source.slice(start, end)),
  ).toEqual(["<x><x/></x>", "<x/>"]);
});
