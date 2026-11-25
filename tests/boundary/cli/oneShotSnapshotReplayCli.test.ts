import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";

import { elf } from "../../../src/domain/binaryTarget.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { fakeKunaCalls, writeFakeKuna } from "../providers/kuna/fakeKuna.js";

describe("one-shot --snapshot replay disclosure", () => {
  cliTest(
    "says when a provider's live answer is saved but will not replay",
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-snapshot-live-cli-");
      const kuna = await writeFakeKuna(root, {
        functions: [{ name: "main", addr: "0x1000" }],
      });
      const target = join(root, "target.elf");
      await writeFile(target, elf(2, 1, 62));
      const snapshot = join(root, "snapshot.json");
      const search = (...extra: string[]) =>
        cli.run({
          arguments: [
            "search",
            target,
            "main",
            "--kind",
            "procedures",
            "--provider",
            "kuna",
            "--json",
            ...extra,
          ],
          cwd: root,
          environment: {
            REA_LOG_LEVEL: "silent",
            REA_KUNA_COMMAND: kuna,
            REA_KUNA_CACHE_DIR: join(root, "cache"),
          },
        });

      const inventoryReads = async () =>
        (await fakeKunaCalls(kuna)).filter(
          ({ argv }) => argv[0] === "functions",
        ).length;
      const runs = [];
      for (let index = 0; index < 2; index++) {
        const before = await inventoryReads();
        const result = await search("--snapshot", snapshot);
        expect(result.exitCode, result.stderr).toBe(0);
        // Each call reads the provider's inventory again; nothing replayed.
        expect(await inventoryReads()).toBeGreaterThan(before);
        runs.push(parseEvidence(result.json));
      }
      for (const evidence of runs)
        expect(evidence.limitations).toContainEqual(
          expect.stringContaining(
            "Not saved for snapshot replay: kuna declares this result live",
          ),
        );
      // The snapshot holds no replay entry.
      const saved = JSON.parse(await readFile(snapshot, "utf8")) as {
        entries: unknown[];
      };
      expect(saved.entries).toEqual([]);

      const plain = await search();
      expect(plain.exitCode, plain.stderr).toBe(0);
      expect(parseEvidence(plain.json).limitations).not.toContainEqual(
        expect.stringContaining("Not saved for snapshot replay"),
      );
    },
  );
});
