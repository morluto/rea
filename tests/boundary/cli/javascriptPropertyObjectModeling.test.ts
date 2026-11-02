import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { javaScriptSemanticTraceResultSchema } from "../../../src/domain/javascript/javascriptSemanticTraceSchemas.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "traces literals inside post-declaration property objects through the public commands",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-property-objects-");
    for (const [name, receiver] of [
      ["function", "function Game() {}"],
      ["assigned", "const Game = {};"],
    ] as const) {
      const directory = join(root, name);
      await mkdir(directory);
      await writeFile(
        join(directory, "main.js"),
        `${receiver}
Game.config = { ACCEL: 0.001 };
export function accel() { return Game.config.ACCEL; }
`,
      );
      // The compiled CLI prepares Darwin ownership helpers; hosts that select
      // a matching SDK explicitly must pass that selection through, as the
      // other compiled-CLI lifecycle tests do.
      const environment: { readonly SDKROOT: string } | Record<string, never> =
        process.env.SDKROOT === undefined
          ? {}
          : { SDKROOT: process.env.SDKROOT };
      const analyzed = await cli.run({
        arguments: ["analyze-javascript-application", directory, "--json"],
        environment,
      });
      expect(analyzed.exitCode).toBe(0);
      const queryFile = join(root, `${name}.json`);
      await writeFile(
        queryFile,
        JSON.stringify({
          application: analyzed.json,
          query: {
            seed: { kind: "literal", value: 0.001 },
            direction: "forward-influence",
          },
        }),
      );
      const traced = await cli.run({
        arguments: ["trace-javascript-semantics", queryFile, "--json"],
        environment,
      });
      expect(traced.exitCode).toBe(0);
      const { normalized_result: result } = z
        .object({ normalized_result: javaScriptSemanticTraceResultSchema })
        .parse(traced.json);
      expect(result.status).toBe("found");
      expect(result.nodes.map((node) => node.label)).toEqual(
        expect.arrayContaining(["read:/config/ACCEL", "return"]),
      );
    }
  },
  120_000,
);
