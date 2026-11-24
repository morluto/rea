import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { artifactComparisonResultSchema } from "../../src/domain/artifactComparison.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../src/domain/artifactGraph.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { zipArchive } from "../../src/domain/desktop/zipArchive.fixture.js";
import { nugetNupkgSchema } from "../../src/domain/nuget/nupkg.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest.for([
  { claim: "directory size", name: "dir/", flags: 0 },
  { claim: "directory descriptor", name: "dir/", flags: 0x8 },
  { claim: "encrypted member size", name: "encrypted.bin", flags: 1 },
])(
  "keeps an unverified ZIP $claim unknown through CLI and MCP",
  async ({ claim, name, flags }, { cli }) => {
    const root = await createTestTempDirectory("rea-zip-extent-coverage-");
    const path = join(root, "fixture.zip");
    const hidden = { name: "hidden.txt", data: "secret", method: 0 };
    const bytes = zipArchive([
      {
        name,
        flags,
        method: 0,
        centralCompressedSize:
          30 + Buffer.byteLength(hidden.name) + hidden.data.length,
      },
      { ...hidden, listed: false },
    ]);
    await writeFile(path, bytes);
    const inspected = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    const evidence = inspection.substeps[0]?.evidence;
    const inventory = artifactInventoryResultSchema.parse(
      evidence?.normalized_result,
    );
    expect(inventory.coverage.status).toBe("unknown");
    expect(
      inventory.occurrences.map((item) => item.logical_path),
    ).not.toContain(hidden.name);
    expect(inventory.manifest.root_sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );

    const call = await cli.sharedMcpCall?.();
    if (call === undefined)
      throw new Error("Expected the compiled MCP fixture");
    const opened = await call("open_binary", { path });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    try {
      const response = await call("inspect_artifact", {});
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const mcpInspection = artifactInspectionResultSchema.parse(
        parseEvidence(response.structuredContent).normalized_result,
      );
      expect(
        artifactInventoryResultSchema.parse(
          mcpInspection.substeps[0]?.evidence.normalized_result,
        ),
      ).toEqual(inventory);
    } finally {
      const closed = await call("close_binary", {});
      expect(closed.isError, JSON.stringify(closed)).not.toBe(true);
    }

    if (claim === "directory size") {
      const seedPath = join(root, "seed.zip");
      await writeFile(seedPath, zipArchive([{ name, method: 0 }, hidden]));
      const seedResult = await cli.run({
        arguments: ["inspect-artifact", seedPath, "--json"],
      });
      expect(seedResult.exitCode, seedResult.stdout + seedResult.stderr).toBe(
        0,
      );
      const seed = artifactInspectionResultSchema.parse(
        parseEvidence(seedResult.json).normalized_result,
      ).substeps[0]?.evidence;
      const seedInventory = artifactInventoryResultSchema.parse(
        seed?.normalized_result,
      );
      expect(seedInventory.coverage.status).toBe("complete");
      expect(
        seedInventory.occurrences.map((item) => item.logical_path),
      ).toContain(hidden.name);

      const compared = await call("compare_artifacts", {
        left: seed,
        right: evidence,
      });
      expect(compared.isError, JSON.stringify(compared)).not.toBe(true);
      const comparison = artifactComparisonResultSchema.parse(
        parseEvidence(compared.structuredContent).normalized_result,
      );
      expect(
        comparison.changes.find((change) => change.logical_path === hidden.name)
          ?.classification,
      ).toBe("unknown");

      const extracted = await cli.run({
        arguments: ["extract-artifact", path, "--json"],
        environment: { TMPDIR: root, TMP: root, TEMP: root },
      });
      expect(extracted.exitCode, extracted.stdout + extracted.stderr).toBe(0);
      const result = artifactExtractionResultSchema.parse(
        parseEvidence(extracted.json).normalized_result,
      );
      expect(result.coverage.status).toBe("unknown");
    }
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);

cliTest(
  "keeps NuGet listing coverage unknown when a directory claim covers an omitted member",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-nupkg-extent-coverage-");
    const path = join(root, "fixture.nupkg");
    const hidden = {
      name: "lib/hidden.dll",
      data: "unlisted library",
      method: 0,
      listed: false,
    };
    const bytes = zipArchive([
      {
        name: "demo.nuspec",
        method: 0,
        data: "<package><metadata><id>Demo</id><version>1.0</version></metadata></package>",
      },
      {
        name: "dir/",
        method: 0,
        centralCompressedSize:
          30 + Buffer.byteLength(hidden.name) + hidden.data.length,
      },
      hidden,
    ]);
    await writeFile(path, bytes);
    const inspected = await cli.run({
      arguments: ["inspect-nuget-nupkg", path, "--json"],
    });
    expect(inspected.exitCode, inspected.stdout + inspected.stderr).toBe(0);
    const report = nugetNupkgSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    );
    expect(report.coverage.status).toBe("unknown");
    const call = await cli.sharedMcpCall?.();
    if (call === undefined)
      throw new Error("Expected the compiled MCP fixture");
    const response = await call("inspect_nuget_nupkg", { path });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(
      nugetNupkgSchema.parse(
        parseEvidence(response.structuredContent).normalized_result,
      ),
    ).toEqual(report);
    expect(report.contents.map((entry) => entry.path)).not.toContain(
      hidden.name,
    );
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);
