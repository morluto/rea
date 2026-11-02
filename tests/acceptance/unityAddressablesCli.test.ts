import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  analysisViewResultSchema,
  unityAddressablesSummaryViewResultSchema,
} from "../../src/domain/analysisView/analysisView.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { unityAddressablesSchema } from "../../src/domain/unity/unityAddressables.js";
import {
  binaryCatalog,
  jsonCatalog,
  sampleCatalog,
} from "../fixtures/unity/addressables.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest, runFileCli } from "../support/cli/cliFixture.js";

const parseCliCatalog = (value: unknown) =>
  unityAddressablesSchema.parse(
    toolContract("inspect_unity_addressables").outputSchema.parse(value)
      .normalized_result,
  );

cliTest(
  "returns the same catalog through CLI and MCP and pages retained rows after the file is gone",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-addressables-cli-");
    const { call } = await connectLocalToolsMcp();
    for (const [name, bytes] of [
      ["catalog.json", jsonCatalog()],
      ["catalog.bin", binaryCatalog(sampleCatalog(), { version: 2 })],
    ] as const) {
      const path = join(root, name);
      const hashPath = join(root, `${name}.hash`);
      await writeFile(path, bytes);
      await writeFile(hashPath, "0123456789abcdef0123456789abcdef");
      const output = await runFileCli(cli, {
        arguments: [
          "inspect-unity-addressables",
          path,
          "--hash",
          hashPath,
          "--json",
        ],
      });
      expect(output.exitCode, output.stderr).toBe(0);
      const report = parseCliCatalog(output.json);
      expect(report.hash_file?.text).toBe("0123456789abcdef0123456789abcdef");
      const complete = await call("inspect_unity_addressables", {
        path,
        hash_path: hashPath,
        detail: "complete",
      });
      expect(complete.isError, JSON.stringify(complete)).not.toBe(true);
      expect(
        parseEvidence(complete.structuredContent).normalized_result,
      ).toEqual(report);

      const summarized = await call("inspect_unity_addressables", { path });
      expect(summarized.isError, JSON.stringify(summarized)).not.toBe(true);
      const view = unityAddressablesSummaryViewResultSchema.parse(
        parseEvidence(summarized.structuredContent).normalized_result,
      );
      expect(view.summary.counts).toEqual({
        providers: 4,
        keys: 7,
        locations: 5,
        bundles: 2,
        dependency_edges: 4,
      });
      expect((await readFile(path)).equals(bytes)).toBe(true);
      await unlink(path);
      const page = await call("inspect_analysis_view", {
        source: {
          kind: "retained-evidence",
          evidence_id: view.parent_evidence_id,
        },
        view: {
          kind: "unity-addressables",
          collection: "locations",
          key_indices: [5],
          fields: ["internal_id", "data"],
        },
      });
      expect(page.isError, JSON.stringify(page)).not.toBe(true);
      const projected = analysisViewResultSchema.parse(
        parseEvidence(page.structuredContent).normalized_result,
      );
      if (projected.kind !== "unity-addressables")
        throw new Error("Wrong Addressables page kind");
      expect(projected.items.map((item) => item.index)).toEqual([0, 1]);
      expect(projected.items[0]).toMatchObject({
        data: { kind: "asset-bundle", crc: 3145479169 },
      });
    }
  },
  30000,
);
