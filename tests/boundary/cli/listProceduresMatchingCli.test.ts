import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect } from "vitest";

import { elf } from "../../../src/domain/binaryTarget.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { nativeFunctionMatchingSchema } from "../../../src/domain/native/functionMatching.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { writeFakeKuna } from "../providers/kuna/fakeKuna.js";

/** Two fake-Kuna targets whose inventories share `main` and differ otherwise. */
const createSides = async () => {
  const root = await createTestTempDirectory("rea-list-procedures-cli-");
  const side = async (
    name: string,
    functions: { name: string; addr: string }[],
  ) => {
    const directory = join(root, name);
    await mkdir(directory);
    const kuna = await writeFakeKuna(directory, { functions });
    const target = join(directory, "target.elf");
    // Distinct bytes give the two sides distinct target identities.
    await writeFile(target, Buffer.concat([elf(2, 1, 62), Buffer.from(name)]));
    return { directory, kuna, target };
  };
  return {
    root,
    left: await side("left", [
      { name: "main", addr: "0x1000" },
      { name: "old_name", addr: "0x1100" },
    ]),
    right: await side("right", [
      { name: "main", addr: "0x2000" },
      { name: "new_name", addr: "0x2100" },
    ]),
  };
};

const kunaEnvironment = (side: { directory: string; kuna: string }) => ({
  REA_LOG_LEVEL: "silent",
  REA_KUNA_COMMAND: side.kuna,
  REA_KUNA_CACHE_DIR: join(side.directory, "cache"),
});

describe("list-procedures feeds match-native-functions", () => {
  cliTest(
    "produces the inventory the matcher accepts, inline and through a bundle",
    async ({ cli }) => {
      const { root, left, right } = await createSides();
      const list = async (
        side: typeof left,
        ...extra: string[]
      ): Promise<unknown> => {
        const result = await cli.run({
          arguments: [
            "list-procedures",
            side.target,
            "--provider",
            "kuna",
            "--json",
            ...extra,
          ],
          cwd: root,
          environment: kunaEnvironment(side),
        });
        expect(result.exitCode, result.stderr).toBe(0);
        return result.json;
      };

      // Complete delivery: stdout is the list_procedures Evidence itself.
      const leftEvidence = parseEvidence(await list(left));
      expect(leftEvidence).toMatchObject({
        operation: "list_procedures",
        normalized_result: expect.arrayContaining([
          expect.objectContaining({ address: "0x1000", value: "main" }),
          expect.objectContaining({ address: "0x1100", value: "old_name" }),
        ]),
      });

      // Summary delivery retains the complete inventory in a bundle.
      const bundlePath = join(root, "right-bundle.json");
      const delivered = (await list(
        right,
        "--detail",
        "summary",
        "--evidence_output",
        bundlePath,
      )) as { summary: unknown };
      const summary = parseEvidence(delivered.summary);
      const parentId = (
        summary.normalized_result as { parent_evidence_id: string }
      ).parent_evidence_id;
      const bundle = parseEvidenceBundle(
        JSON.parse(await readFile(bundlePath, "utf8")),
      );
      expect(
        bundle.records.find((record) => record.evidence_id === parentId),
      ).toMatchObject({ operation: "list_procedures" });

      const request = join(root, "request.json");
      await writeFile(
        request,
        JSON.stringify({
          left: leftEvidence,
          right: { kind: "retained-evidence", evidence_id: parentId },
          detail: "complete",
        }),
      );
      const matched = await cli.run({
        arguments: [
          "match-native-functions",
          request,
          "--source_bundle",
          bundlePath,
          "--evidence_output",
          join(root, "matching.json"),
          "--json",
        ],
        cwd: root,
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(matched.exitCode, matched.stderr).toBe(0);
      const report = nativeFunctionMatchingSchema.parse(
        parseEvidence(matched.json).normalized_result,
      );
      // Every row of both selected inventories is accounted for.
      const rows = (evidence: { normalized_result: unknown }) =>
        (evidence.normalized_result as unknown[]).length;
      const rightComplete = parseEvidence(
        bundle.records.find((record) => record.evidence_id === parentId),
      );
      // Independently of matching: the bundled inventory kept the fixture rows.
      expect(rightComplete.normalized_result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ address: "0x2000", value: "main" }),
          expect.objectContaining({ address: "0x2100", value: "new_name" }),
        ]),
      );
      const {
        matched: pairs,
        only_left,
        only_right,
        unresolved,
      } = report.summary;
      expect(unresolved).toBe(0);
      expect(pairs + only_left).toBe(rows(leftEvidence));
      expect(pairs + only_right).toBe(rows(rightComplete));
    },
  );
});

describe("match-native-functions inventory refusal", () => {
  cliTest(
    "names the inventory producer when a search result is selected",
    async ({ cli }) => {
      const { root, left } = await createSides();
      const search = await cli.run({
        arguments: [
          "search",
          left.target,
          "--pattern=.",
          "--mode",
          "regex",
          "--kind",
          "procedures",
          "--provider",
          "kuna",
          "--json",
        ],
        cwd: root,
        environment: kunaEnvironment(left),
      });
      expect(search.exitCode, search.stderr).toBe(0);
      const searched = parseEvidence(search.json);
      expect(searched.operation).toBe("search_procedures");

      const request = join(root, "request.json");
      await writeFile(
        request,
        JSON.stringify({ left: searched, right: searched, detail: "complete" }),
      );
      const refused = await cli.run({
        arguments: ["match-native-functions", request, "--json"],
        cwd: root,
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(refused.exitCode).not.toBe(0);
      expect(refused.json).toMatchObject({
        code: "invalid_request",
        details: { issues: [{ path: ["left"], reason: "invalid_value" }] },
        remediation: {
          action: expect.stringContaining("rea list-procedures"),
        },
      });

      const { call } = await connectLocalToolsMcp();
      const mcp = await call("match_native_functions", {
        left: searched,
        right: searched,
      });
      expect(mcp.isError).toBe(true);
      expect(parseMcpToolError(mcp)).toMatchObject({
        error: {
          code: "invalid_request",
          remediation: {
            action: expect.stringContaining("MCP list_procedures"),
          },
        },
      });
    },
  );
});
