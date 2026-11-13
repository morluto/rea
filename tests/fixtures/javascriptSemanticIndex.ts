import type * as t from "@babel/types";

import { indexJavaScriptBindingsWithReceiversSteps } from "../../src/domain/javascript/javascriptSemanticAnalysis.js";
import type { JavaScriptSemanticPrecisionInput } from "../../src/domain/javascript/javascriptSemanticPrecision.js";

export function* indexJavaScriptBindingsSteps(
  program: t.Program,
  precision?: JavaScriptSemanticPrecisionInput,
) {
  const index = yield* indexJavaScriptBindingsWithReceiversSteps(
    program,
    undefined,
    precision,
  );
  yield* index.indexAmbientWritesSteps();
  return index.bindings;
}
