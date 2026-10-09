import { expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { topLevelBinding } from "./javascriptSemanticAnalysis.fixture.js";

it("retains distinct module origins when a property contains the old separator", () => {
  const result = analyzeJavaScriptSemantics(
    'import * as ns from "./fixture.js"; const selected = choice ? ns["a\\0b"] : ns.a.b;',
  );
  const provenance = topLevelBinding(result, "selected").provenance;
  expect(provenance.status).toBe("ambiguous");
  expect(provenance.origins.map(({ importedPath }) => importedPath)).toEqual(
    expect.arrayContaining([["a\0b"], ["a", "b"]]),
  );
  expect(provenance.origins).toHaveLength(2);
});
