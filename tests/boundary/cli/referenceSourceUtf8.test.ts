import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { historicalSourceGraphSchema } from "../../../src/domain/referenceSourceGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "retains malformed source bytes without inventing decoded import targets",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-reference-utf8-");
    const sources = new Map([
      [
        "invalid.mjs",
        Buffer.concat([
          Buffer.from('import "./caf'),
          Buffer.from([0xff]),
          Buffer.from('.js";\n'),
        ]),
      ],
      [
        "comment.ts",
        Buffer.concat([
          Buffer.from('import "./dep.js"; // '),
          Buffer.from([0xc0, 0xaf]),
        ]),
      ],
      ["valid.mjs", Buffer.from('import "./caf�.js";\n')],
      ["caf�.js", Buffer.from("export const value = 1;\n")],
      ["dep.js", Buffer.from("export const value = 2;\n")],
    ]);
    await Promise.all(
      [...sources].map(([path, bytes]) => writeFile(join(root, path), bytes)),
    );
    const result = await cli.run({
      arguments: ["import-reference-source", root, "--json"],
      environment: { HOME: root, XDG_CONFIG_HOME: root, XDG_CACHE_HOME: root },
    });
    expect(result.exitCode).toBe(0);
    const graph = historicalSourceGraphSchema.parse(result.json);
    expect(graph.parse_failures).toEqual([
      {
        path: "comment.ts",
        parser: "utf-8",
        reason:
          "Source bytes are not valid UTF-8; import targets were not parsed.",
      },
      {
        path: "invalid.mjs",
        parser: "utf-8",
        reason:
          "Source bytes are not valid UTF-8; import targets were not parsed.",
      },
    ]);
    expect(graph.relationships).toEqual([
      {
        from_path: "valid.mjs",
        to: "caf�.js",
        kind: "imports",
        resolution: "internal",
        parse_state: "parsed",
      },
    ]);
    for (const [path, bytes] of sources)
      expect(graph.entries).toContainEqual(
        expect.objectContaining({
          path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.length,
          content_state: "hashed",
        }),
      );
  },
);
