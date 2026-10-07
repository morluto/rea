import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Filter } from "incur";
import { expect } from "vitest";
import { z } from "zod";

import { analyzeJavaScriptApplication } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const filter = "evidence_id,normalized_result.graph.nodes[0:1].node_id";

for (const command of ["analyze-javascript-application", "analyze"]) {
  for (const format of ["json", "jsonl"]) {
    for (const fullOutput of [false, true]) {
      for (const filtered of [false, true]) {
        cliTest(
          `${command} preserves ${format}, full output ${String(fullOutput)}, filtering ${String(filtered)}`,
          async ({ cli }) => {
            const root = await createTestTempDirectory("rea-js-json-output-");
            await writeFile(join(root, "main.js"), "fetch('');\n");
            const direct = await analyzeJavaScriptApplication({
              input_path: root,
            });
            if (!direct.ok) throw direct.error;
            const output = await cli.run({
              arguments: [
                command,
                root,
                "--format",
                format,
                ...(fullOutput ? ["--full-output"] : []),
                ...(filtered ? ["--filter-output", filter] : []),
              ],
            });
            expect(output.exitCode).toBe(0);
            let data: unknown = output.json;
            if (fullOutput) {
              const envelope = z
                .object({
                  ok: z.literal(true),
                  data: z.unknown(),
                  meta: z.object({
                    command: z.literal(command),
                    duration: z.string().regex(/^\d+ms$/u),
                  }),
                })
                .parse(output.json);
              data = envelope.data;
            }
            expect(data).toEqual(
              filtered
                ? Filter.apply(direct.value, Filter.parse(filter))
                : direct.value,
            );
          },
        );
      }
    }
  }
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
