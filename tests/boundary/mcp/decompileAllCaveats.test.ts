import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAnalysisExecution,
  type AnalysisOperationPort,
} from "../../../src/application/AnalysisProvider.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { err, ok } from "../../../src/domain/result.js";
import {
  AnalysisOutputError,
  AnalysisInputError,
} from "../../../src/domain/analysisErrorCore.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  decompileDirectoryIndexSchema,
  decompileDirectoryManifestSchema,
} from "../../../src/contracts/decompileDirectory.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { closeEnhancedToolResources, connect } from "./enhancedToolsHarness.js";

const provider = { id: "fixture", name: "Fixture", version: "1" };
const profile = createAnalysisProfile(provider, { decompiler: "fixture" });
const addresses = Array.from(
  { length: 20 },
  (_, index) => `0x${(0x1000 + index * 0x10).toString(16)}`,
);

const longCaveat = "long provider caveat ".repeat(600);

/** A provider that, like Ghidra, names each function's terminal call address. */
const addressCaveats: AnalysisOperationPort = {
  execute: (operation, parameters) => {
    const observe = (value: unknown, limitations: readonly string[] = []) =>
      Promise.resolve(
        ok(
          createAnalysisExecution(value, provider, {
            analysisProfile: profile,
            limitations,
          }),
        ),
      );
    const address = String(parameters.procedure);
    if (operation === "list_procedures")
      return observe(
        addresses.map((entry) => ({ address: entry, value: entry })),
      );
    if (operation === "procedure_info")
      return observe(null, [`procedure_info caveat at ${address}`]);
    return observe(`int f(void) { return 0; }`, [
      `terminal call at ${address}`,
      ...(address === addresses.at(-1) ? [longCaveat] : []),
    ]);
  },
};

afterEach(closeEnhancedToolResources);

describe("decompile_all MCP caveats", () => {
  it("returns a bounded caveat summary and keeps each function's caveats in its file", async () => {
    const parent = await createTestTempDirectory("rea-decompile-caveats-");
    const client = await connect(addressCaveats);
    const result = await client.callTool({
      name: "decompile_all",
      arguments: { output_directory: join(parent, "out") },
    });
    expect(result.isError).not.toBe(true);
    const evidence = parseEvidence(result.structuredContent);
    expect(evidence.normalized_result).toMatchObject({
      counts: { written: 20, failed: 0 },
    });
    // 40 address-specific caveats plus one oversized caveat: 8 kept and 33 counted, beside the workflow
    // line and this target-less fixture's identity caveat.
    expect(evidence.limitations).toHaveLength(11);
    expect(evidence.limitations.at(-1)).toMatch(
      /^33 per-item provider limitation observations were omitted/u,
    );
    const last = await readFile(
      join(parent, "out", "functions", `${addresses.at(-1)}.c`),
      "utf8",
    );
    expect(last).toContain(`procedure_info caveat at ${addresses.at(-1)}`);
    expect(last).toContain(`terminal call at ${addresses.at(-1)}`);
    expect(JSON.stringify(result)).not.toContain(longCaveat);
    const index = JSON.parse(
      await readFile(join(parent, "out", "decompile-index.json"), "utf8"),
    );
    expect(index.functions.at(-1).limitations).toContain(longCaveat);
  });
});

it("keeps long-name failures inside the tool window and complete in the index", async () => {
  const parent = await createTestTempDirectory("rea-decompile-long-failures-");
  const output = join(parent, "out");
  const names = Array.from(
    { length: 32 },
    (_, index) => `${'a"\\\0😀'.repeat(400)}-${index}`,
  );
  const caveat = "\0".repeat(2_000);
  const port: AnalysisOperationPort = {
    execute: async (operation) =>
      operation === "procedure_pseudo_code"
        ? err(new AnalysisInputError(operation))
        : ok(
            createAnalysisExecution(
              operation === "list_procedures"
                ? names.map((name, index) => ({
                    address: `0x${(0x1000 + index).toString(16)}`,
                    value: name,
                  }))
                : null,
              provider,
              {
                analysisProfile: profile,
                ...(operation === "procedure_info"
                  ? { limitations: [caveat] }
                  : {}),
              },
            ),
          ),
  };
  const client = await connect(port);
  const result = await client.callTool({
    name: "decompile_all",
    arguments: { output_directory: output },
  });
  expect(result.isError).not.toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(50 * 1_024);
  const evidence = parseEvidence(result.structuredContent);
  const manifest = decompileDirectoryManifestSchema.parse(
    evidence.normalized_result,
  );
  expect(manifest.counts.failed).toBe(32);
  expect(manifest.failures.length).toBeGreaterThan(0);
  expect(manifest.failures_omitted + manifest.failures.length).toBe(32);
  expect(manifest.failures.every((failure) => !("name" in failure))).toBe(true);
  expect(manifest.failures.every((failure) => failure.code.length > 0)).toBe(
    true,
  );
  expect(JSON.stringify(result)).not.toContain(caveat);
  const index = decompileDirectoryIndexSchema.parse(
    JSON.parse(await readFile(join(output, "decompile-index.json"), "utf8")),
  );
  expect(index.functions.map((record) => record.name)).toEqual(names);
  expect(
    index.functions.every((record) => record.limitations?.includes(caveat)),
  ).toBe(true);
});

it.each(["procedure_info", "procedure_pseudo_code"] as const)(
  "reports %s cleanup failure through MCP while retaining completed files",
  async (operation) => {
    const parent = await createTestTempDirectory("rea-decompile-cleanup-");
    const output = join(parent, "out");
    const failure = new AnalysisOutputError(
      operation,
      "provider close failed",
      {
        cleanup: {
          reason: "provider close denied",
          resources: ["provider descriptor"],
        },
      },
    );
    const port: AnalysisOperationPort = {
      execute: (selected, parameters, options) =>
        selected === operation && parameters.procedure === addresses[1]
          ? Promise.resolve(err(failure))
          : addressCaveats.execute(selected, parameters, options),
    };
    const client = await connect(port);
    const result = await client.callTool({
      name: "decompile_all",
      arguments: { output_directory: output },
    });
    expect(result.isError).toBe(true);
    expect(parseMcpToolError(result).error).toMatchObject({
      code: "cleanup_incomplete",
      details: { cleanup: "incomplete" },
    });
    const index = decompileDirectoryIndexSchema.parse(
      JSON.parse(await readFile(join(output, "decompile-index.json"), "utf8")),
    );
    expect(index.functions).toHaveLength(1);
    expect(index.functions[0]).toMatchObject({
      address: addresses[0],
      status: "written",
    });
    await expect(
      readFile(join(output, "functions", `${addresses[0]}.c`), "utf8"),
    ).resolves.toContain("int f(void)");
  },
);
