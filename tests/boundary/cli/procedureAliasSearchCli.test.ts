import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";

import { elf } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { writeFakeKuna } from "../providers/kuna/fakeKuna.js";

describe("procedure alias search CLI", () => {
  cliTest(
    "finds and traces a procedure by an alias exact lookup accepts",
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-alias-search-cli-");
      const kuna = await writeFakeKuna(root, {
        functions: [
          { name: "main", addr: "0x1000" },
          {
            name: "audit_v1",
            addr: "0x1334",
            aliases: ["audit_transform", "sub_1334"],
          },
          {
            name: "audit_v2",
            addr: "0x133a",
            aliases: ["audit_transform", "sub_133a"],
          },
        ],
      });
      const target = join(root, "target.elf");
      await writeFile(target, elf(2, 1, 62));
      const run = async (...arguments_: string[]) => {
        const result = await cli.run({
          arguments: [...arguments_, "--provider", "kuna", "--format", "json"],
          cwd: root,
          environment: {
            REA_LOG_LEVEL: "silent",
            REA_KUNA_COMMAND: kuna,
            REA_KUNA_CACHE_DIR: join(root, "cache"),
          },
        });
        expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
        return result.json;
      };

      expect(
        await run(
          "search",
          target,
          "audit_transform",
          "--kind",
          "procedures",
          "--mode",
          "regex",
        ),
      ).toMatchObject({
        operation: "search_procedures",
        normalized_result: [
          {
            address: "0x1334",
            value: "audit_v1",
            matched_aliases: ["audit_transform"],
          },
          {
            address: "0x133a",
            value: "audit_v2",
            matched_aliases: ["audit_transform"],
          },
        ],
      });
      expect(await run("trace", target, "sub_1334")).toMatchObject({
        operation: "trace_feature",
        normalized_result: {
          matches: [
            {
              type: "procedure",
              address: "0x1334",
              value: "audit_v1",
              matched_aliases: ["sub_1334"],
            },
          ],
          references: [{ target_address: "0x1334", source_address: "0x1004" }],
        },
      });
    },
  );
});
