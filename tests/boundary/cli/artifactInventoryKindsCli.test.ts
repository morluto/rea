import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { minimalElfImage } from "../../fixtures/nativeHeaders.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";

const elfHeader = new Uint8Array(minimalElfImage());

cliTest(
  "selects inventory occurrences by recognized artifact kind",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-inventory-kinds-cli-");
    const archive = join(root, "app.zip");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add(
      "main.js",
      new TextReader("require('./build/Release/a.node');\n"),
    );
    await writer.add("build/Release/a.node", new Uint8ArrayReader(elfHeader));
    await writer.add("lib/b.node", new Uint8ArrayReader(elfHeader));
    await writer.add("lib/c.so", new Uint8ArrayReader(elfHeader));
    await writeFile(archive, await writer.close());
    const bundlePath = join(root, "bundle.json");
    const inspected = await cli.run({
      arguments: [
        "inspect-artifact",
        archive,
        "--detail",
        "summary",
        "--evidence_output",
        bundlePath,
        "--json",
      ],
    });
    expect(inspected.exitCode).toBe(0);
    const parent = parseEvidenceBundle(
      JSON.parse(await readFile(bundlePath, "utf8")),
    ).records.find((record) => record.operation === "inspect_artifact")!;
    const view = async (selection: Record<string, unknown>) => {
      const request = join(root, "view.json");
      await writeFile(
        request,
        JSON.stringify({
          source: { kind: "inline", evidence: parent },
          view: {
            kind: "inventory",
            collection: "occurrences",
            fields: ["logical_path", "artifact_kind"],
            ...selection,
          },
        }),
      );
      const projected = await cli.run({
        arguments: ["inspect-analysis-view", request, "--json"],
      });
      expect(projected.exitCode).toBe(0);
      return parseEvidence(projected.json).normalized_result as {
        items: { logical_path: string; artifact_kind: string }[];
        coverage: { total: number };
      };
    };

    const addons = await view({ artifact_kinds: ["native-addon"] });
    expect(addons.items.map((item) => item.logical_path).sort()).toEqual([
      "build/Release/a.node",
      "lib/b.node",
    ]);
    expect(addons.coverage.total).toBe(2);
    expect(
      addons.items.every((item) => item.artifact_kind === "native-addon"),
    ).toBe(true);

    // Selectors intersect; an empty kind list selects nothing.
    const intersected = await view({
      artifact_kinds: ["native-addon", "dynamic-library"],
      logical_paths: ["lib/b.node", "lib/c.so", "main.js"],
    });
    expect(intersected.items.map((item) => item.logical_path)).toEqual([
      "lib/b.node",
      "lib/c.so",
    ]);
    const none = await view({ artifact_kinds: [] });
    expect(none.items).toEqual([]);
    expect(none.coverage.total).toBe(0);
  },
);
