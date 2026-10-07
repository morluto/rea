import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  createNonApplicationZipInventory,
  requireSuccessfulProjection,
} from "../../support/applicationSessionFixture.js";

import { projectAndroidApplicationEvidence } from "../../../src/application/android/AndroidApplicationService.js";
import { runProviderAnalysis } from "../../../src/composition/directAnalysis.js";
import { androidApplicationProjectionResultSchema } from "../../../src/domain/android/androidApplication.js";
import { parseEvidence } from "../../../src/domain/evidence.js";

describe("Android application projection", () => {
  it("projects deterministic APK components and explicit bridge hypotheses", async () => {
    const root = await createTestTempDirectory("rea-android-");
    const path = join(root, "Fixture.apk");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add(
      "AndroidManifest.xml",
      new Uint8ArrayReader(Uint8Array.from([3, 0, 8, 0])),
    );
    await writer.add(
      "classes.dex",
      new Uint8ArrayReader(
        Uint8Array.from([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0]),
      ),
    );
    await writer.add(
      "lib/arm64-v8a/libreactnativejni.so",
      new Uint8ArrayReader(
        Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
      ),
    );
    await writer.add("assets/index.js", new TextReader("bridge();"));
    await writer.add("META-INF/FIXTURE.RSA", new TextReader("opaque signing"));
    await writeFile(path, await writer.close());

    const inventory = parseEvidence(
      await runProviderAnalysis(path, "inventory_artifact", {}),
    );
    const first = projectAndroidApplicationEvidence({
      inventory_evidence: [inventory],
    });
    const second = projectAndroidApplicationEvidence({
      inventory_evidence: [inventory],
    });
    const left = androidApplicationProjectionResultSchema.parse(
      requireSuccessfulProjection(first).normalized_result,
    );
    const right = androidApplicationProjectionResultSchema.parse(
      requireSuccessfulProjection(second).normalized_result,
    );
    expect(left).toEqual(right);
    expect(left).toMatchObject({
      root_format: "apk",
      coverage: {
        status: "complete-within-inventory",
        inventory_complete: true,
      },
    });
    expect(left.components.manifests).toHaveLength(1);
    expect(left.components.dex).toHaveLength(1);
    expect(left.components.native_libraries).toHaveLength(1);
    expect(left.components.javascript).toHaveLength(1);
    expect(left.components.signing).toHaveLength(1);
    expect(left.runtime_families).toEqual(
      expect.arrayContaining([
        "dalvik-art",
        "javascript",
        "native",
        "react-native",
      ]),
    );
    expect(left.bridge_candidates).toEqual([
      expect.objectContaining({ basis: "react-native-convention" }),
    ]);
    expect(JSON.stringify(left)).not.toContain("opaque signing");
  });

  it("rejects non-APK inventory Evidence", async () => {
    const inventory = await createNonApplicationZipInventory(
      "rea-android-invalid-",
    );
    expect(
      projectAndroidApplicationEvidence({ inventory_evidence: [inventory] }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
  });

  it("keeps uppercase path-derived bytecode families distinct from byte validity", async () => {
    const root = await createTestTempDirectory("rea-android-suffixes-");
    const path = join(root, "Suffixes.apk");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    for (const entry of [
      "classes.DEX",
      "extra.dex",
      "Main.CLASS",
      "Other.class",
    ])
      await writer.add(entry, new TextReader("unrecognized bytes"));
    await writeFile(path, await writer.close());

    const inventory = parseEvidence(
      await runProviderAnalysis(path, "inventory_artifact", {}),
    );
    const result = projectAndroidApplicationEvidence({
      inventory_evidence: [inventory],
    });
    const projection = androidApplicationProjectionResultSchema.parse(
      requireSuccessfulProjection(result).normalized_result,
    );

    expect(projection.components.dex.map(({ path }) => path).sort()).toEqual([
      "classes.DEX",
      "extra.dex",
    ]);
    expect(
      projection.components.jvm_classes.map(({ path }) => path).sort(),
    ).toEqual(["Main.CLASS", "Other.class"]);
    expect(
      projection.components.dex.every(({ format }) => format === "file"),
    ).toBe(true);
    expect(
      projection.components.jvm_classes.every(
        ({ format }) => format === "file",
      ),
    ).toBe(true);
    expect(projection.runtime_families).toEqual(["dalvik-art", "java-kotlin"]);
    expect(projection.limitations).toContain(
      "Runtime families are inferred from inventory formats and paths; filename suffixes do not establish valid DEX or JVM class bytes.",
    );
  });

  it("returns every component and bridge candidate from the inventory", async () => {
    const root = await createTestTempDirectory("rea-android-complete-");
    const path = join(root, "Fixture.apk");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    const dex = Uint8Array.from([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0]);
    for (let index = 0; index < 1_001; index += 1)
      await writer.add(
        `classes${String(index).padStart(4, "0")}.dex`,
        new Uint8ArrayReader(dex),
      );
    await writer.add("lib/arm64-v8a/libnative.so", new TextReader("native"));
    await writeFile(path, await writer.close());

    const inventory = parseEvidence(
      await runProviderAnalysis(path, "inventory_artifact", {}),
    );
    const result = projectAndroidApplicationEvidence({
      inventory_evidence: [inventory],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const projection = androidApplicationProjectionResultSchema.parse(
      result.value.normalized_result,
    );
    expect(projection.components.dex).toHaveLength(1_001);
    expect(projection.bridge_candidates).toHaveLength(1_001);
    expect(projection.coverage.status).toBe("complete-within-inventory");
  });
});
