import { expect, it } from "vitest";

import {
  MACOS_PKG_MAX_TOC_PATH_BYTES,
  MACOS_PKG_MAX_TOC_XML_NODES,
} from "../../domain/macosPkgFormat.js";
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

it("refuses TOC nested paths past the expanded path-byte allowance before joining", () => {
  const dir = "d".repeat(1024 * 1024);
  const children = Array.from(
    { length: 5 },
    (_, index) =>
      `<file id="${String(index + 2)}"><name>f${String(index)}</name><type>file</type></file>`,
  ).join("");
  const parsed = parseXarTocXml(
    toc(
      `<file id="1"><name>${dir}</name><type>directory</type>${children}</file>`,
    ),
  );
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error).toMatchObject({
    kind: "limit",
    failure: {
      limit: {
        name: "macos_pkg_toc_path_bytes",
        maximum: MACOS_PKG_MAX_TOC_PATH_BYTES,
      },
    },
  });
});

it("keeps valid TOC files and signatures alongside named refusals for damaged records", () => {
  const parsed = parseXarTocXml(
    toc(
      '<signature style="RSA"/>' +
        '<file id="1"><name>PackageInfo</name><type>file</type></file>' +
        '<file id="2"><name>broken.bin</name><type>file</type><data><offset>0</offset><length>4</length></data></file>' +
        '<file id="3"><name>../escape</name><type>file</type></file>' +
        '<file id="4"><name>Bom</name><type>file</type></file>',
    ),
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value.files.map((file) => file.path)).toEqual([
    "PackageInfo",
    "Bom",
  ]);
  expect(parsed.value.signatures).toHaveLength(1);
  expect(parsed.value.refusals).toEqual([
    expect.objectContaining({
      path: "broken.bin",
      error: expect.objectContaining({
        message: expect.stringContaining("<size>"),
      }),
    }),
    expect.objectContaining({
      path: null,
      error: expect.objectContaining({
        message: expect.stringContaining("../escape"),
      }),
    }),
  ]);
});
