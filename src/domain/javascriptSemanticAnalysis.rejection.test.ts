import { fc, it } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import {
  onlyCallable,
  topLevelBinding,
} from "./javascriptSemanticAnalysis.fixture.js";

describe("JavaScript semantic analysis: rejection 1", () => {
  it("reports reference, module-link, depth, and object-property limits", () => {
    const retained = analyzeJavaScriptSemantics(
      `
        const first = require("first");
        const second = require("second");
        first;
        second;
      `,
      { maxModuleLinks: 1, maxReferences: 1 },
    );
    expect(retained.moduleLinks).toHaveLength(1);
    expect(retained.references).toHaveLength(1);
    expect(retained.coverage.limitsReached).toEqual(
      expect.arrayContaining(["maxModuleLinks", "maxReferences"]),
    );

    const object = analyzeJavaScriptSemantics(
      "const object = { first: 1, second: 2 };",
      { maxObjectProperties: 1 },
    );
    expect(topLevelBinding(object, "object").value).toMatchObject({
      status: "object",
      unknownProperties: true,
    });
    expect(object.coverage.limitsReached).toContain("maxObjectProperties");

    const depth = analyzeJavaScriptSemantics(
      'const first = "value"; const second = first;',
      { maxValueDepth: 1 },
    );
    expect(topLevelBinding(depth, "second").value).toMatchObject({
      status: "limit-reached",
    });
    expect(depth.coverage.limitsReached).toContain("maxValueDepth");
  });

  it("is deterministic and returns failed coverage for an unparseable source", () => {
    const source = 'const { value: renamed } = require("fixture");';
    expect(analyzeJavaScriptSemantics(source)).toEqual(
      analyzeJavaScriptSemantics(source),
    );
    expect(analyzeJavaScriptSemantics("function {")).toMatchObject({
      scopes: [],
      bindings: [],
      callables: [],
      references: [],
      coverage: { status: "failed", omittedCount: null },
    });
  });

  it("does not mark parser-recovered duplicate bindings complete", () => {
    const ir = analyzeJavaScriptSemantics(
      "const duplicate = 'first'; const duplicate = 'second';",
    );

    expect(ir.coverage).toMatchObject({
      status: "partial",
      omittedCount: 0,
    });
    expect(topLevelBinding(ir, "duplicate").value).toMatchObject({
      status: "ambiguous",
    });
    expect(ir.limitations.join(" ")).toMatch(/parser recovered/iu);
  });

  it("keeps parser-recovered return shapes partial", () => {
    const ir = analyzeJavaScriptSemantics(
      `
        export default function recovered(value) {
          const duplicate = 1;
          const duplicate = 2;
          return { type: "item", text: render(value) };
        }
      `,
    );
    const recovered = onlyCallable(ir, "recovered");

    expect(ir.coverage.status).toBe("partial");
    expect(recovered.returnCoverage).toMatchObject({
      status: "partial",
      retainedCount: 1,
      omittedCount: 0,
    });
    expect(recovered.returnSites[0]?.value).toMatchObject({
      status: "object",
      properties: expect.arrayContaining([
        { name: "type", value: { status: "literal", value: "item" } },
        expect.objectContaining({
          name: "text",
          value: expect.objectContaining({ status: "unknown" }),
        }),
      ]),
    });
  });

  it.prop([fc.string({ maxLength: 512 })])(
    "fails closed for arbitrary bounded source text",
    (source) => {
      const ir = analyzeJavaScriptSemantics(source, {
        maxBindings: 64,
        maxCallables: 64,
        maxModuleLinks: 64,
        maxReferences: 256,
        maxScopes: 64,
      });

      expect(ir.schema).toBe("JavaScriptSemanticIR");
      expect(["complete", "partial", "truncated", "failed"]).toContain(
        ir.coverage.status,
      );
      if (ir.coverage.status === "failed") {
        expect(ir.scopes).toEqual([]);
        expect(ir.bindings).toEqual([]);
        expect(ir.callables).toEqual([]);
      }
    },
  );
});
