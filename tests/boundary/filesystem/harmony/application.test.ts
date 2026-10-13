import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import {
  createNonApplicationZipInventory,
  inventoryApplicationPackage,
  requireDeterministicProjection,
  requireSuccessfulProjection,
  writeApplicationZip,
} from "../../../support/applicationSessionFixture.js";

import { projectHarmonyApplicationEvidence } from "../../../../src/application/harmony/HarmonyApplicationService.js";
import { createDirectAnalysis } from "../../../../src/composition/directAnalysis.js";
import { harmonyApplicationProjectionResultSchema } from "../../../../src/domain/harmony/harmonyApplication.js";
import { artifactInventoryResultSchema } from "../../../../src/domain/artifactGraph.js";
import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import {
  ZIP_PACKAGE_FORMATS,
  ZIP_NON_ENTRY_TAIL_LIMITATION,
} from "../../../../src/domain/zipPackageFormat.js";

const { runProviderAnalysis } = createDirectAnalysis({});
const elf = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);

const stageHapEntries = [
  { path: "module.json", content: '{"module":{"name":"entry"}}' },
  { path: "ets/modules.abc", content: "panda bytecode" },
  { path: "libs/arm64-v8a/libentry.so", content: elf },
  { path: "resources.index", content: "resource index" },
  { path: "resources/base/profile/main_pages.json", content: "{}" },
  { path: "assets/web/index.js", content: "bridge();" },
  { path: "META-INF/FIXTURE.p7b", content: "opaque signing" },
] as const;

describe("HarmonyOS application projection", () => {
  it("projects deterministic Stage HAP components and explicit bridge hypotheses", async () => {
    const path = await writeApplicationZip(
      "rea-harmony-",
      "Fixture.hap",
      stageHapEntries,
    );
    const inventory = await inventoryApplicationPackage(path);
    expect(inventory.subject?.format).toBe("hap");
    const left = requireDeterministicProjection(
      projectHarmonyApplicationEvidence,
      inventory,
      harmonyApplicationProjectionResultSchema,
    );
    expect(left).toMatchObject({
      root_format: "hap",
      packaging_model: "stage",
      coverage: {
        status: "complete-within-inventory",
        inventory_complete: true,
      },
    });
    expect(left.components.manifests.map(({ path }) => path)).toEqual([
      "module.json",
    ]);
    expect(left.components.bytecode.map(({ path }) => path)).toEqual([
      "ets/modules.abc",
    ]);
    expect(left.components.resources.map(({ path }) => path).sort()).toEqual([
      "resources.index",
      "resources/base/profile/main_pages.json",
    ]);
    expect(left.components.native_libraries).toHaveLength(1);
    expect(left.components.javascript).toHaveLength(1);
    expect(left.components.signing).toHaveLength(1);
    expect(left.runtime_families).toEqual(["ark", "javascript", "native"]);
    expect(left.bridge_candidates).toEqual([
      expect.objectContaining({
        managed_path: "ets/modules.abc",
        native_path: "libs/arm64-v8a/libentry.so",
        basis: "napi-library-convention",
      }),
    ]);
    expect(left.app_pack_children).toEqual([]);
    expect(JSON.stringify(left)).not.toContain("opaque signing");
    expect(left.limitations).toContain(
      "Manifest, module, resource, and signing semantics require a dedicated HarmonyOS provider; this projection reports exact inventory paths and hashes only.",
    );
  });

  it("projects App Pack children by path without recursive inventory", async () => {
    const entryHap = await writeApplicationZip(
      "rea-harmony-entry-",
      "entry.hap",
      [
        { path: "module.json", content: '{"module":{}}' },
        { path: "ets/modules.abc", content: "panda" },
      ],
    );
    const featureHsp = await writeApplicationZip(
      "rea-harmony-feature-",
      "feature.hsp",
      [{ path: "module.json", content: '{"module":{}}' }],
    );
    const path = await writeApplicationZip("rea-harmony-app-", "Bundle.app", [
      { path: "pack.info", content: '{"packages":[]}' },
      { path: "entry.hap", content: new Uint8Array(await readFile(entryHap)) },
      {
        path: "feature.hsp",
        content: new Uint8Array(await readFile(featureHsp)),
      },
    ]);
    const inventory = await inventoryApplicationPackage(path);
    expect(inventory.subject?.format).toBe("app-pack");
    const projection = requireDeterministicProjection(
      projectHarmonyApplicationEvidence,
      inventory,
      harmonyApplicationProjectionResultSchema,
    );
    expect(projection.root_format).toBe("app-pack");
    expect(projection.components.manifests.map(({ path }) => path)).toEqual([
      "pack.info",
    ]);
    expect(projection.app_pack_children.map(({ path }) => path).sort()).toEqual(
      ["entry.hap", "feature.hsp"],
    );
    expect(projection.packaging_model).toBe("unknown");
    expect(projection.limitations).toContain(
      "App Pack child packages are listed by inventory path only; their contents are not recursively inventoried by this projection.",
    );
  });
});

describe("HarmonyOS packaging boundaries", () => {
  it("keeps a nested .app ZIP member inside an IPA out of the App Pack classification", async () => {
    const nested = await writeApplicationZip(
      "rea-harmony-nested-",
      "Nested.app",
      [{ path: "inner.txt", content: "not an app pack" }],
    );
    const path = await writeApplicationZip("rea-harmony-ipa-", "Fixture.ipa", [
      { path: "Payload/App.app/Info.plist", content: "plist" },
      {
        path: "Payload/Nested.app",
        content: new Uint8Array(await readFile(nested)),
      },
    ]);
    const inventory = await inventoryApplicationPackage(path);
    expect(inventory.subject?.format).toBe("ipa");
    const occurrences = (
      inventory.normalized_result as {
        occurrences: Array<{
          logical_path: string;
          artifact_format: string;
        }>;
      }
    ).occurrences;
    const nestedOccurrence = occurrences.find(
      ({ logical_path }) => logical_path === "Payload/Nested.app",
    );
    expect(nestedOccurrence?.artifact_format).toBe("zip");
  });

  it("claims the FA model only from config.json", async () => {
    const path = await writeApplicationZip("rea-harmony-fa-", "Legacy.hap", [
      { path: "config.json", content: '{"app":{}}' },
      { path: "assets/js/default.js", content: "legacy();" },
      { path: "assets/entry/resources.index", content: "resource index" },
      {
        path: "assets/entry/resources/base/element/strings.json",
        content: "{}",
      },
      { path: "assets/feature/resources/rawfile/icon.png", content: "image" },
    ]);
    const inventory = await inventoryApplicationPackage(path);
    const result = projectHarmonyApplicationEvidence({
      inventory_evidence: [inventory],
    });
    const projection = harmonyApplicationProjectionResultSchema.parse(
      requireSuccessfulProjection(result).normalized_result,
    );
    expect(projection.packaging_model).toBe("fa");
    expect(projection.runtime_families).toEqual(["javascript"]);
    expect(projection.components.resources.map(({ path }) => path)).toEqual([
      "assets/entry/resources.index",
      "assets/entry/resources/base/element/strings.json",
      "assets/feature/resources/rawfile/icon.png",
    ]);
  });

  it("rejects non-HarmonyOS inventory Evidence", async () => {
    const inventory = await createNonApplicationZipInventory(
      "rea-harmony-invalid-",
    );
    expect(
      projectHarmonyApplicationEvidence({ inventory_evidence: [inventory] }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
  });

  it("keeps HTTP Archive .har files out of the HarmonyOS classification", async () => {
    const root = await createTestTempDirectory("rea-harmony-http-har-");
    const path = join(root, "capture.har");
    await writeFile(
      path,
      JSON.stringify({ log: { version: "1.2", creator: {}, entries: [] } }),
    );
    const result = await runProviderAnalysis(path, "inventory_artifact", {});
    expect(result).toMatchObject({
      error: "Analysis failed",
      code: "target_unavailable",
    });
  });
});

describe("HarmonyOS inventory coverage", () => {
  it("keeps a case-colliding inventory partial in the application projection", async () => {
    const path = await writeApplicationZip(
      "rea-harmony-case-collision-",
      "Fixture.hap",
      [
        { path: "module.json", content: '{"module":{}}' },
        { path: "MODULE.JSON", content: '{"module":{}}' },
      ],
    );
    const inventory = await inventoryApplicationPackage(path);
    expect(inventory.normalized_result).toMatchObject({
      coverage_status: "partial",
    });

    const projection = requireDeterministicProjection(
      projectHarmonyApplicationEvidence,
      inventory,
      harmonyApplicationProjectionResultSchema,
    );
    expect(projection.coverage).toEqual({
      status: "partial",
      inventory_complete: true,
    });
    expect(projection.limitations).toContain(
      "Source inventory coverage is partial; absence is unknown.",
    );
  });

  it.each(ZIP_PACKAGE_FORMATS)(
    "retains archive identity and ZIP coverage for %s",
    async (format) => {
      const suffix = format === "app-pack" ? "app" : format;
      const path = await writeApplicationZip(
        "rea-package-family-",
        `Fixture.${suffix}`,
        [{ path: "module.json", content: "{}" }],
      );
      const target = await parseBinaryTarget(path);
      if (!target.ok) throw target.error;
      expect(target.value).toMatchObject({ kind: "archive", format });
      const evidence = await inventoryApplicationPackage(path);
      const inventory = artifactInventoryResultSchema.parse(
        evidence.normalized_result,
      );
      expect(
        inventory.occurrences.find(({ logical_path }) => logical_path === "."),
      ).toMatchObject({
        artifact_kind: "container",
        artifact_format: format,
      });
      expect(inventory.limitations).toContain(ZIP_NON_ENTRY_TAIL_LIMITATION);
    },
  );

  it("preserves unavailable encrypted component paths and qualifies absence", async () => {
    const root = await createTestTempDirectory("rea-harmony-encrypted-");
    const path = join(root, "Locked.hap");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("module.json", new TextReader("{}"));
    await writer.add("ets/modules.abc", new TextReader("opaque bytecode"), {
      password: "fixture-only",
    });
    await writeFile(path, await writer.close());
    const evidence = await inventoryApplicationPackage(path);
    const projection = requireDeterministicProjection(
      projectHarmonyApplicationEvidence,
      evidence,
      harmonyApplicationProjectionResultSchema,
    );
    expect(projection.components.bytecode).toEqual([]);
    expect(projection.unavailable_components).toEqual([
      expect.objectContaining({
        path: "ets/modules.abc",
        artifact_id: null,
        sha256: null,
        encrypted: true,
      }),
    ]);
    expect(projection.coverage).toEqual({
      status: "partial",
      inventory_complete: true,
    });
    expect(projection.limitations).toContainEqual(
      expect.stringContaining("component and runtime absence is unknown"),
    );
  });
});
