import { describe, expect, it } from "vitest";

import {
  createEsmModuleProfileCollector,
  parseLinuxVmRssBytes,
} from "../../../scripts/lib/mcp-startup-probe.mjs";

describe("MCP startup policy", () => {
  it("parses Linux resident memory without accepting other fields", () => {
    expect(
      parseLinuxVmRssBytes("Name:\tnode\nVmRSS:\t  12345 kB\nThreads:\t7\n"),
    ).toBe(12_641_280);
    expect(parseLinuxVmRssBytes("VmSize:\t12345 kB\n")).toBeNull();
  });

  it("profiles unique file-backed ESM modules without retaining paths", () => {
    const collector = createEsmModuleProfileCollector();
    collector.append(
      "ESM 1: Storing file:///opt/rea/dist/main.js\n" +
        "ESM 1: Translating StandardModule file:///opt/rea/dist/main.js\n" +
        "ESM 1: Storing file:///opt/rea/node_modules/zod/index.js",
    );

    expect(collector.result()).toEqual({
      supported: true,
      method: "node-debug-esm",
      unique_file_modules: 2,
      unique_package_modules: 0,
      unique_dependency_modules: 1,
      debug_lines: 3,
      truncated: false,
    });
  });
});
