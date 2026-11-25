import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { analysisErrorProjectionSchema } from "../../../src/domain/analysisErrorProjectionSchema.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "reports the unconfigured xpanda checkout as a capability boundary",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-harmony-abc-cli-");
    const target = join(root, "module.abc");
    await writeFile(target, "PANDA\0\0\0fake-ark-bytecode");
    const result = await cli.run({
      arguments: ["inspect-harmony-abc", target, "--json"],
      cwd: root,
      environment: {},
    });
    expect(result.exitCode).toBe(1);
    const projection = analysisErrorProjectionSchema.parse(result.json);
    expect(projection.code).toBe("capability_unavailable");
    expect(projection.message).toContain("REA_XPANDA_ROOT");
  },
);

cliTest(
  "requires the class selector for single-class decompilation",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-harmony-abc-cli-");
    const target = join(root, "module.abc");
    await writeFile(target, "PANDA\0\0\0fake-ark-bytecode");
    const result = await cli.run({
      arguments: ["decompile-harmony-abc-class", target, "--json"],
      cwd: root,
      environment: {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: [{ path: "className" }],
    });
  },
);

cliTest(
  "keeps the graph format distinct from the output format",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: ["build-harmony-abc-call-graph", "--help"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--graph-format <json|mermaid>");
  },
);
