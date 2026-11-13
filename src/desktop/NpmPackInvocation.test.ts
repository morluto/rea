import { describe, expect, it } from "vitest";

import { npmInvocation } from "../../scripts/lib/npm-invocation.mjs";

describe("npmInvocation for the build-computer pack", () => {
  it("keeps a temporary directory that contains spaces as one argument", () => {
    const destination =
      "C:\\Users\\Ada Lovelace\\AppData\\Local\\Temp\\rea-build-runtime-1";
    const entry =
      "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
    const invoked = npmInvocation(["pack", "--pack-destination", destination], {
      npm_execpath: entry,
    });

    expect(invoked.arguments).toEqual([
      entry,
      "pack",
      "--pack-destination",
      destination,
    ]);
    expect(invoked.command).not.toMatch(/npm\.cmd$/u);
  });
});
