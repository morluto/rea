import { expect, it } from "vitest";

import { analyzeCommonJsStaticFixture } from "../../fixtures/javascriptCommonJsAnalysis.js";

// The source analyzer runs on a child process's main-thread stack. This forked
// project shares that stack size; worker threads have a larger default stack.
it("selects a published binding list wider than call arguments allow", () => {
  const publish = (count: number) => {
    const bindings = Array.from({ length: count }, (_, i) => `v${i}`);
    const source = `const{app}=require('electron');export const[${bindings.join(",")}]=[0,app.setAppPath];`;
    const analysis = analyzeCommonJsStaticFixture(source);
    expect(analysis.parse_error_count).toBe(0);
    // The possible change is the exported declaration, which ends the source.
    return (analysis.electron.app_path_changes ?? []).map(
      ({ location, ...change }) => {
        expect(location.end).toEqual({ line: 1, column: source.length });
        return { ...change, start: location.start };
      },
    );
  };
  const control = publish(3);
  expect(control).toHaveLength(1);
  // More bindings than one call can receive as arguments on V8's default stack.
  expect(publish(130_000)).toEqual(control);
});
