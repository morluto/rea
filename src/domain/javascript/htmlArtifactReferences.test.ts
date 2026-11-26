import { expect, it } from "vitest";

import { htmlArtifactReferences } from "./htmlArtifactReferences.js";

it.each([
  ['<script data-src="decoy.js"></script>', []],
  ['<script x:src="decoy.js"></script>', []],
  [`<script title='src="decoy.js"'></script>`, []],
  [
    `<SCRIPT title=">" data-src="decoy.js" SRC='actual.js'></SCRIPT>`,
    ["actual.js"],
  ],
  ['<script src="actual.js" src="decoy.js"></script>', ["actual.js"]],
  ['<script src="" src="decoy.js"></script>', []],
  ['<script src="actual&#46;js"></script>', ["actual.js"]],
  ['<!-- <script src="decoy.js"></script> -->', []],
  ['<textarea><script src="decoy.js"></script></textarea>', []],
  ['<style><script src="decoy.js"></script></style>', []],
  [`<script>const text = '<script src="decoy.js">';</script>`, []],
  [
    '<template><base href="decoy/"><script src="decoy.js"></script></template>',
    [],
  ],
  ['<svg><script src="decoy.js"></script></svg>', []],
  [
    '<svg><foreignObject><script src="actual.js"></script></foreignObject></svg>',
    ["actual.js"],
  ],
])("extracts document references from %s", (text, expected) => {
  expect(
    htmlArtifactReferences(text).scripts.map(({ scriptPath }) => scriptPath),
  ).toEqual(expected);
});

it("retains exact opening-tag coordinates rather than the script body", () => {
  const opening = '<script\n title=">" src=actual.js>';
  const prefix = "<!doctype html>\n\n";
  const text = `${prefix}${opening}ignored body</script>`;
  expect(htmlArtifactReferences(text)).toEqual({
    baseHref: null,
    inlineScripts: [],
    inlineScriptCount: 0,
    scripts: [
      {
        scriptPath: "actual.js",
        scriptType: "classic",
        location: {
          start: { line: 3, column: 0 },
          end: { line: 4, column: ' title=">" src=actual.js>'.length },
        },
      },
    ],
  });
});

it.each([
  ['<base data-href="decoy/"><base href=actual/>', "actual/"],
  ['<base href="actual&#47;" href="decoy/"><base href="later/">', "actual/"],
  ['<base href=""><base href="decoy/">', ""],
  ['<template><base href="decoy/"></template><base href="actual/">', "actual/"],
  ['<!-- <base href="decoy/"> --><base title=">" href="actual/">', "actual/"],
])("selects the first real base href from %s", (text, expected) => {
  expect(htmlArtifactReferences(text).baseHref).toBe(expected);
});

it("traverses deep valid document content without recursive stack growth", () => {
  const depth = 12_000;
  const text = `${"<div>".repeat(depth)}<script src=actual.js></script>${"</div>".repeat(depth)}`;
  expect(
    htmlArtifactReferences(text).scripts.map(({ scriptPath }) => scriptPath),
  ).toEqual(["actual.js"]);
});

it.each([
  ["<script>run();</script>", ["classic"]],
  ['<script type="">run();</script>', ["classic"]],
  ['<script type=" Text/JavaScript ">run();</script>', ["classic"]],
  ['<script type="application/x-javascript">run();</script>', ["classic"]],
  ['<script language="javascript">run();</script>', ["classic"]],
  ['<script language="">run();</script>', ["classic"]],
  ['<script type="MODULE">import "./x.js";</script>', ["module"]],
  // Only the JavaScript MIME check strips whitespace; `module` must match.
  ['<script type=" module ">import "./x.js";</script>', []],
  ['<script language=" javascript ">run();</script>', []],
  ["<script nomodule>run();</script>", ["classic"]],
  // A src attribute, even an empty one, means the browser ignores the body.
  ['<script src="actual.js">run();</script>', []],
  ['<script src="">run();</script>', []],
  ["<script>  \n\t </script>", []],
  ['<script type="application/json">{"a":1}</script>', []],
  ['<script type="application/ld+json">{}</script>', []],
  ['<script type="importmap">{"imports":{}}</script>', []],
  ['<script type="speculationrules">{}</script>', []],
  ['<script type="text/template"><p>x</p></script>', []],
  ['<script language="vbscript">run()</script>', []],
  ["<!-- <script>run();</script> -->", []],
  ["<template><script>run();</script></template>", []],
  ["<svg><script>run();</script></svg>", ["classic"]],
])("classifies inline JavaScript in %s", (text, expected) => {
  expect(
    htmlArtifactReferences(text).inlineScripts.map(
      ({ scriptType }) => scriptType,
    ),
  ).toEqual(expected);
});

it.each([
  ['src="ignored.js"', null, "classic"],
  ['other:href="ignored.js"', null, "classic"],
  ['language="vbscript"', null, "classic"],
  ['xlink:type="simple"', null, "classic"],
  ['type=" Text/JavaScript "', null, "classic"],
  ['type="MODULE"', null, "module"],
  ['type=" module "', null, null],
  ['type="application/json"', null, null],
  ['type="text/javascript; charset=utf-8"', null, null],
  ['href="external.js"', "external.js", null],
  ['xlink:href="external.js"', "external.js", null],
  ['href="first.js" xlink:href="second.js"', "first.js", null],
  ['xlink:href="second.js" href="first.js"', "first.js", null],
  ['href="" xlink:href="ignored.js"', null, null],
] as const)(
  "retains the effective SVG script source or inline body with %s",
  (attributes, source, type) => {
    const result = htmlArtifactReferences(
      `<svg><script ${attributes}>run();</script></svg>`,
    );
    expect(result.scripts.map(({ scriptPath }) => scriptPath)).toEqual(
      source === null ? [] : [source],
    );
    expect(result.inlineScripts.map(({ scriptType }) => scriptType)).toEqual(
      type === null ? [] : [type],
    );
    expect(result.inlineScriptCount).toBe(type === null ? 0 : 1);
  },
);

it("retains exact SVG body coordinates and skips SVG inside templates", () => {
  const prefix = '<!doctype html>\n<svg><script src="ignored.js">';
  const body = "\nrun();\n";
  const result = htmlArtifactReferences(
    `${prefix}${body}</script></svg><template><svg><script>x</script></svg></template>`,
  );
  expect(result.inlineScriptCount).toBe(1);
  expect(result.inlineScripts).toEqual([
    {
      scriptType: "classic",
      text: body,
      location: { start: { line: 2, column: 30 }, end: { line: 4, column: 0 } },
    },
  ]);
});

it("retains exact inline script body coordinates, including unclosed scripts", () => {
  const prefix = "<!doctype html>\n<script>";
  const body = "\nfetch('/api');\n";
  for (const ending of ["</script><p>after</p>", ""])
    expect(
      htmlArtifactReferences(`${prefix}${body}${ending}`).inlineScripts,
    ).toEqual([
      {
        scriptType: "classic",
        location: {
          start: { line: 2, column: 8 },
          end: { line: 4, column: 0 },
        },
        text: body,
      },
    ]);
});

it.each([
  ['type=" Text/JavaScript "', "classic"],
  ['type="MODULE"', "module"],
  ['type="application/json"', null],
  ['type="importmap"', null],
  ['type="speculationrules"', null],
  ['language="vbscript"', null],
  ['type=" module "', null],
])(
  "retains external src with parsed JavaScript type for %s",
  (attributes, scriptType) => {
    expect(
      htmlArtifactReferences(`<script ${attributes} src="source.js"></script>`)
        .scripts,
    ).toMatchObject([{ scriptPath: "source.js", scriptType }]);
  },
);
