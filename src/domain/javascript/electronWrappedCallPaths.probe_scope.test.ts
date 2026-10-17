import { describe, expect, it } from "vitest";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

// A hoisted function reads a binding whose initializer appears later in the
// module, the shape production bundles such as react-dom take for timers.
const LATER_INITIALIZED_READ = `
function schedule(callback) {
  return scheduleTimeout(callback, 0);
}
var scheduleTimeout = "function" === typeof setTimeout ? setTimeout : void 0;
module.exports = { schedule };
`;
const UNKNOWN_LIMITATION = expect.stringContaining("remain unknown");

describe("isolated-world bridge probe scope", () => {
  it("keeps a module without Electron identity complete when a hoisted read precedes its initializer", () => {
    const result = analyzeJavaScriptStaticSource(LATER_INITIALIZED_READ);

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("complete");
    expect(result.limitations).not.toContainEqual(UNKNOWN_LIMITATION);
    expect(result.electron.call_paths).toBeUndefined();
  });

  it("keeps the same read unknown beside Electron identity, where an isolated-world exposure could hide", () => {
    const result = analyzeJavaScriptStaticSource(
      `const e = require("electron");\ne.app.quit();\n${LATER_INITIALIZED_READ}`,
    );

    expect(result.parse_error_count).toBe(0);
    expect(result.parse_status).toBe("partial");
    expect(result.limitations).toContainEqual(UNKNOWN_LIMITATION);
  });
});
