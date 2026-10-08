import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Filter } from "incur";
import { expect } from "vitest";
import { z } from "zod";

import { analyzeJavaScriptApplication } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const filter = "evidence_id,normalized_result.graph.nodes[0:1].node_id";

for (const scenario of [
  {
    command: "analyze-javascript-application",
    format: "json",
    fullOutput: false,
    filtered: true,
  },
  {
    command: "analyze-javascript-application",
    format: "jsonl",
    fullOutput: true,
    filtered: true,
  },
  { command: "analyze", format: "json", fullOutput: true, filtered: false },
  { command: "analyze", format: "jsonl", fullOutput: false, filtered: false },
] as const) {
  cliTest(
    `${scenario.command} preserves representative ${scenario.format} output`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-js-json-output-");
      await writeFile(join(root, "main.js"), "fetch('');\n");
      const direct = await analyzeJavaScriptApplication({ input_path: root });
      if (!direct.ok) throw direct.error;
      const output = await cli.run({
        arguments: [
          scenario.command,
          root,
          "--format",
          scenario.format,
          ...(scenario.fullOutput ? ["--full-output"] : []),
          ...(scenario.filtered ? ["--filter-output", filter] : []),
        ],
      });
      expect(output.exitCode).toBe(0);
      let data: unknown = output.json;
      if (scenario.fullOutput) {
        const envelope = z
          .object({
            ok: z.literal(true),
            data: z.unknown(),
            meta: z.object({
              command: z.literal(scenario.command),
              duration: z.string().regex(/^\d+ms$/u),
            }),
          })
          .parse(output.json);
        data = envelope.data;
      }
      expect(data).toEqual(
        scenario.filtered
          ? Filter.apply(direct.value, Filter.parse(filter))
          : direct.value,
      );
    },
  );
}

cliTest(
  "preserves a complete empty filtered JSON document",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-js-json-empty-filter-");
    await writeFile(join(root, "main.js"), "export const value = 1;\n");
    const output = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        "--json",
        "--filter-output",
        "absent.field",
      ],
    });
    expect(output.exitCode).toBe(0);
    expect(output.json).toEqual({});
  },
);

cliTest(
  "preserves a typed failed analysis in the JSON result",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-js-json-failure-");
    const output = await cli.run({
      arguments: [
        "analyze-javascript-application",
        join(root, "absent"),
        "--json",
      ],
    });
    expect(output.json).toMatchObject({
      code: "artifact_operation_failed",
      details: { reason: "io" },
    });
  },
);

cliTest(
  "preserves JSON omission for inherited filter methods",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-js-json-inherited-filter-");
    await writeFile(join(root, "main.js"), "export const value = 1;\n");
    const output = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        "--json",
        "--filter-output",
        "toString",
      ],
    });
    expect(output.exitCode).toBe(0);
    expect(output.json).toEqual({});
  },
);
