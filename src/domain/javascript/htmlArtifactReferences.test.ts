import { expect, it } from "vitest";

import { htmlArtifactReferences } from "./htmlArtifactReferences.js";

it.each([
  ['<script data-src="decoy.js"></script>', []],
  ['<script x:src="decoy.js"></script>', []],
  [`<script title='src="decoy.js"'></script>`, []],
  ["<script src=actual.js></script>", ["actual.js"]],
  ['<script title=">" src="actual.js"></script>', ["actual.js"]],
  ['<SCRIPT SRC="actual.js"></SCRIPT>', ["actual.js"]],
  ["<script src='actual.js'></script>", ["actual.js"]],
  ['<script data-src="decoy.js" src="actual.js"></script>', ["actual.js"]],
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
  // The existing extraction contract does not classify script MIME types.
  ['<script type="application/json" src="actual.js"></script>', ["actual.js"]],
])("extracts document references from %s", (text, expected) => {
  expect(
    htmlArtifactReferences(text).scripts.map(({ scriptPath }) => scriptPath),
  ).toEqual(expected);
});

it("retains exact opening-tag offsets rather than the script body", () => {
  const opening = '<script\n title=">" src=actual.js>';
  const prefix = "<!doctype html>\n\n";
  const text = `${prefix}${opening}ignored body</script>`;
  expect(htmlArtifactReferences(text)).toEqual({
    baseHref: null,
    scripts: [
      {
        scriptPath: "actual.js",
        startOffset: prefix.length,
        endOffset: prefix.length + opening.length,
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
