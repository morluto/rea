import { expect, it } from "vitest";

import { MACOS_PKG_MAX_TOC_XML_NODES } from "../../domain/macosPkgFormat.js";
import { parseXarTocXml } from "./XarToc.js";

const toc = (body: string): Buffer =>
  Buffer.from(`<?xml version="1.0"?><xar><toc>${body}</toc></xar>`);

it("parses a TOC file record", () => {
  const parsed = parseXarTocXml(
    toc('<file id="1"><name>PackageInfo</name><type>file</type></file>'),
  );
  expect(parsed.ok && parsed.value.files.map((file) => file.path)).toEqual([
    "PackageInfo",
  ]);
});

it("refuses TOC XML past the node allowance before building a DOM", () => {
  const parsed = parseXarTocXml(
    toc("<x/>".repeat(MACOS_PKG_MAX_TOC_XML_NODES)),
  );
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error).toMatchObject({
    kind: "limit",
    failure: {
      limit: {
        name: "macos_pkg_toc_xml_nodes",
        maximum: MACOS_PKG_MAX_TOC_XML_NODES,
      },
    },
  });
});

it("still refuses a TOC DOCTYPE", () => {
  const parsed = parseXarTocXml(
    Buffer.from('<?xml version="1.0"?><!DOCTYPE xar><xar><toc/></xar>'),
  );
  expect(parsed.ok).toBe(false);
});
