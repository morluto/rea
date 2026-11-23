import { expect, it } from "vitest";

import { analyzeJavaScriptStaticSource } from "../../../tests/fixtures/javascriptStaticAnalysis.js";

const moduleKeys = (source: string): readonly (readonly string[])[] =>
  analyzeJavaScriptStaticSource(source).bundler_registrations.map(
    (registration) => registration.modules.map((module) => module.module_key),
  );

// Webpack writes a chunk's module table as a sparse array instead of an object
// when numeric module ids are dense: webpack 5 with `moduleIds: "natural"` or
// `"size"`, and webpack 4 production builds. Holes are absent ids; an element's
// index (plus any `Array(n).concat` offset) is its id.
it("recovers a webpack chunk whose module table is a sparse array", () => {
  expect(
    moduleKeys(`"use strict";(self.webpackChunk=self.webpackChunk||[]).push([[1],[,,
      (e,n,r)=>{r.r(n),r.d(n,{greet:()=>t});var s=r(3);const t=e=>(0,s.d)(e)+"!"},
      (e,n,r)=>{function s(e){return"hello "+e}r.d(n,{d:()=>s})}]]);`),
  ).toEqual([["2", "3"]]);
});

it("recovers webpack 4 webpackJsonp chunks with array and object tables", () => {
  const analysis = analyzeJavaScriptStaticSource(
    `(window.webpackJsonp=window.webpackJsonp||[]).push([[0],[
      function(e,t,n){e.exports=n(1)},
      function(e,t){e.exports="x"}
    ]]);
    (window.webpackJsonp=window.webpackJsonp||[]).push([[1],{
      123:function(e,t,n){"use strict";n.r(t)}
    }]);`,
  );
  expect(analysis.bundler_registrations).toMatchObject([
    {
      bundler: "webpack",
      runtime: "webpackJsonp",
      chunk_keys: ["0"],
      modules: [{ module_key: "0" }, { module_key: "1" }],
    },
    {
      bundler: "webpack",
      runtime: "webpackJsonp",
      chunk_keys: ["1"],
      modules: [{ module_key: "123" }],
    },
  ]);
});

it("offsets an Array(n).concat module table by its leading hole count", () => {
  expect(
    moduleKeys(`(self.webpackChunk=self.webpackChunk||[]).push([[5],Array(7).concat([
      function(e){e.exports=1},,function(e){e.exports=2}
    ])]);`),
  ).toEqual([["7", "9"]]);
});

it("records array chunk keys without inventing factories from non-functions", () => {
  expect(
    moduleKeys(
      `(self.webpackChunk=self.webpackChunk||[]).push([[1],[1,"two"]]);`,
    ),
  ).toEqual([[]]);
});
