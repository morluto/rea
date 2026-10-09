import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { topLevelBinding } from "./javascriptSemanticAnalysis.fixture.js";

it.each(["ns.value as unknown", "ns.value!", "ns.value satisfies unknown"])(
  "preserves imported provenance through %s",
  (expression) => {
    const ir = analyzeJavaScriptSemantics(
      `import * as ns from "fixture"; const value = ${expression};`,
    );
    expect(topLevelBinding(ir, "value").provenance).toMatchObject({
      status: "module",
      origins: [{ specifier: "fixture", importedPath: ["value"] }],
    });
  },
);
