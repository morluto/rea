import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

it.each([
  {
    source: "const value = (Promise.resolve(1) as Promise<number>);",
    ownership: "assigned",
  },
  {
    source: "const run = () => (Promise.resolve(1) as Promise<number>);",
    ownership: "returned",
  },
  {
    source: "const value = consume(Promise.resolve(1)).then(work);",
    ownership: "unknown",
  },
  {
    source: "const value = consume(Promise.resolve(1));",
    ownership: "unknown",
  },
  {
    source: "async function run() { await consume(Promise.resolve(1)); }",
    ownership: "unknown",
  },
  {
    source: "function run() { return consume(Promise.resolve(1)); }",
    ownership: "unknown",
  },
  { source: "const value = [Promise.resolve(1)];", ownership: "unknown" },
  {
    source: "const value = Promise.all([{promise: Promise.resolve(1)}]);",
    ownership: "unknown",
  },
  { source: "const value = Promise.resolve(1);", ownership: "assigned" },
  {
    source: "async function run() { await Promise.resolve(1); }",
    ownership: "awaited",
  },
  {
    source: "function run() { return Promise.resolve(1); }",
    ownership: "returned",
  },
  {
    source: "const value = Promise.resolve(1).then(work);",
    ownership: "chained",
  },
  {
    source: "const value = Promise.all([Promise.resolve(1)]);",
    ownership: "aggregated",
  },
  { source: "Promise.resolve(1);", ownership: "detached" },
])("retains direct Promise ownership in $source", ({ source, ownership }) => {
  const ir = analyzeJavaScriptSemantics(source);
  const promise = ir.promiseOperations.find(
    ({ method }) => method === "resolve",
  );
  expect(promise).toMatchObject({ ownership });
  if (ownership === "unknown")
    expect(promise).toMatchObject({ ownerBindingId: null, returnSiteId: null });
});
