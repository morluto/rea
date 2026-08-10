import { it } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { semanticBinding } from "./javascriptSemanticIr.js";
import {
  onlyCallable,
  topLevelBinding,
} from "./javascriptSemanticAnalysis.fixture.js";

describe("JavaScript semantic analysis: calls 1", () => {
  it("links exact local calls to parameters, returns, and closure captures", () => {
    const ir = analyzeJavaScriptSemantics(`
      const prefix = "rea";
      function render(value, { mode }) {
        return prefix + value + mode;
      }
      const alias = render;
      const result = alias(input, { mode: "fast" });
    `);

    expect(ir.schemaVersion).toBe(4);
    const render = onlyCallable(ir, "render");
    const call = ir.callSites.find(
      ({ calleeCallableIds }) => calleeCallableIds[0] === render.callableId,
    );
    expect(call).toMatchObject({
      kind: "call",
      callerCallableId: null,
      resolution: "exact",
      calleeCallableIds: [render.callableId],
      arguments: [
        { index: 0, spread: false },
        { index: 1, spread: false },
      ],
    });
    if (call === undefined) throw new Error("Missing render call");
    expect(
      ir.argumentFlows
        .filter(({ callSiteId }) => callSiteId === call.callSiteId)
        .map(({ argumentIndex, parameterBindingId }) => ({
          argumentIndex,
          parameter: semanticBinding(ir, parameterBindingId)?.name,
        })),
    ).toEqual([
      { argumentIndex: 0, parameter: "value" },
      { argumentIndex: 1, parameter: "mode" },
    ]);
    expect(ir.callReturnFlows).toEqual([
      expect.objectContaining({
        callSiteId: call.callSiteId,
        callableId: render.callableId,
        returnSiteId: render.returnSites[0]?.returnSiteId,
      }),
    ]);
    expect(ir.closureCaptures).toEqual([
      expect.objectContaining({
        callableId: render.callableId,
        bindingId: topLevelBinding(ir, "prefix").bindingId,
      }),
    ]);
    expect(ir.frontiers).toEqual([]);
  });

  it("recovers explicit Promise ownership, chains, aggregation, and awaits", () => {
    const ir = analyzeJavaScriptSemantics(`
      async function run(value) {
        const base = Promise.resolve(value);
        const chained = base.then(work).finally(cleanup);
        await chained;
        Promise.resolve(value).then(work);
        return Promise.all([base, Promise.resolve(value)]);
      }
      const settled = Promise.allSettled([Promise.resolve(1)]);
    `);

    expect(
      ir.promiseOperations.map(
        ({ kind, method, ownership, sourceResolution }) => ({
          kind,
          method,
          ownership,
          sourceResolution,
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        {
          kind: "static",
          method: "resolve",
          ownership: "assigned",
          sourceResolution: "complete",
        },
        {
          kind: "chain",
          method: "then",
          ownership: "chained",
          sourceResolution: "complete",
        },
        {
          kind: "chain",
          method: "finally",
          ownership: "assigned",
          sourceResolution: "complete",
        },
        {
          kind: "awaited-expression",
          method: "await",
          ownership: "awaited",
          sourceResolution: "complete",
        },
        {
          kind: "chain",
          method: "then",
          ownership: "detached",
          sourceResolution: "complete",
        },
        {
          kind: "aggregate",
          method: "all",
          ownership: "returned",
          sourceResolution: "complete",
        },
        {
          kind: "aggregate",
          method: "allSettled",
          ownership: "assigned",
          sourceResolution: "complete",
        },
      ]),
    );
    const aggregate = ir.promiseOperations.find(
      ({ method }) => method === "all",
    );
    expect(aggregate?.sourcePromiseIds).toHaveLength(2);
    expect(aggregate?.returnSiteId).not.toBeNull();
  });
});

describe("JavaScript semantic analysis: calls 2", () => {
  it("does not treat a shadowed Promise binding as the intrinsic", () => {
    const ir = analyzeJavaScriptSemantics(`
      function run(Promise) {
        return Promise.resolve(1).then(work);
      }
    `);

    expect(ir.promiseOperations).toEqual([
      expect.objectContaining({
        kind: "chain",
        method: "then",
        ownership: "returned",
        sourcePromiseIds: [],
        sourceResolution: "unresolved",
      }),
    ]);
  });

  it("bounds Promise recovery with an explicit frontier", () => {
    const ir = analyzeJavaScriptSemantics(
      `
        Promise.resolve(1);
        Promise.resolve(2);
        Promise.resolve(3);
      `,
      { maxPromiseOperations: 1 },
    );

    expect(ir.promiseOperations).toHaveLength(1);
    expect(ir.coverage).toMatchObject({
      status: "truncated",
      limitsReached: ["maxPromiseOperations"],
    });
  });

  it("fingerprints formatting and local-name changes identically", () => {
    const left = analyzeJavaScriptSemantics(`
      function calculate(value) {
        const result = value + 1;
        return result;
      }
    `);
    const right = analyzeJavaScriptSemantics(
      "function renamed(input){const output=input+1;return output}",
    );
    const changed = analyzeJavaScriptSemantics(
      "function renamed(input){const output=input+2;return output}",
    );

    expect(left.functionFingerprints).toHaveLength(1);
    expect(right.functionFingerprints).toHaveLength(1);
    expect(left.functionFingerprints[0]?.components).toEqual(
      right.functionFingerprints[0]?.components,
    );
    expect(
      changed.functionFingerprints[0]?.components.literalSetSha256,
    ).not.toBe(left.functionFingerprints[0]?.components.literalSetSha256);
  });

  it("retains ambiguous local callees and explicit dynamic frontiers", () => {
    const ir = analyzeJavaScriptSemantics(`
      function left(value) { return value; }
      function right(value) { return value; }
      const selected = chooseLeft ? left : right;
      selected(input);
      receiver[key](input);
      external(input);
    `);

    const selected = ir.callSites.find(
      ({ resolution }) => resolution === "ambiguous",
    );
    expect(selected?.calleeCallableIds).toEqual(
      [
        onlyCallable(ir, "left").callableId,
        onlyCallable(ir, "right").callableId,
      ].sort(),
    );
    expect(
      ir.argumentFlows.filter(
        ({ callSiteId }) => callSiteId === selected?.callSiteId,
      ),
    ).toHaveLength(2);
    expect(ir.frontiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "dynamic-call",
          reason: expect.stringMatching(/ambiguous/iu),
        }),
        expect.objectContaining({
          kind: "dynamic-property",
          reason: expect.stringMatching(/computed member/iu),
        }),
        expect.objectContaining({
          kind: "dynamic-call",
          reason: "Unresolved call target external.",
        }),
      ]),
    );
  });
});
