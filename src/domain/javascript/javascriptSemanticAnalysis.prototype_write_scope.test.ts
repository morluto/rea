import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

/**
 * A module-level prototype write has to reach the prototype facts, which used to be
 * requested only by `with`, a loop, an array literal or a function.
 *
 * Measured on Node 24.22.1, `Object.prototype.path = "/tmp/a.sock"; net.connect({port: 0,
 * host: 1})` connects over the inherited `path`, so the acquisition exists. Before this,
 * the same statements inside a function kept it while the same statements at the top level
 * did not, which made the answer depend on where the write was written rather than on what
 * it does.
 */
const acquisitionsFor = (body: string) =>
  analyzeJavaScriptSemantics(
    `import net from "node:net";\n${body}`,
  ).resourceOperations.filter(({ kind }) => kind === "acquire");

it.each([
  [
    "a top-level prototype member write",
    `Object.prototype.path = "/tmp/a.sock";\nnet.connect({ port: 0, host: 1 });`,
  ],
  [
    "the same write inside a function",
    `function g() { Object.prototype.path = "/tmp/a.sock"; net.connect({ port: 0, host: 1 }); }`,
  ],
  [
    "a top-level delete of a prototype member",
    `delete Object.prototype.path;\nnet.connect({ port: 0, host: 1 });`,
  ],
] as const)("keeps the socket acquisition for %s", (_name, body) => {
  expect(acquisitionsFor(body)).toHaveLength(1);
});

it("still reports nothing when the prototype carries no path", () => {
  // The numeric host is what makes this throw, and no prototype write is present.
  expect(acquisitionsFor(`net.connect({ port: 0, host: 1 });`)).toEqual([]);
});
