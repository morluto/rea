import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { projectAndroidApplicationEvidence } from "../src/application/AndroidApplicationService.js";
import { runProviderAnalysis } from "../src/application/DirectAnalysis.js";
import { androidApplicationProjectionResultSchema } from "../src/domain/androidApplication.js";
import { parseEvidence } from "../src/domain/evidence.js";

describe("Android application projection", () => {
  it("projects deterministic APK components and explicit bridge hypotheses", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-android-"));
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
      await runProviderAnalysis(path, "inventory_artifact", {
        node_limit: 500,
        occurrence_limit: 500,
        edge_limit: 500,
      }),
    );
    const first = projectAndroidApplicationEvidence({
      inventory_evidence: [inventory],
      limits: { max_components: 100 },
    });
    const second = projectAndroidApplicationEvidence({
      inventory_evidence: [inventory],
      limits: { max_components: 100 },
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const left = androidApplicationProjectionResultSchema.parse(
      first.value.normalized_result,
    );
    const right = androidApplicationProjectionResultSchema.parse(
      second.value.normalized_result,
    );
    expect(left).toEqual(right);
    expect(left).toMatchObject({
      root_format: "apk",
      coverage: {
        status: "complete-within-inventory",
        inventory_complete: true,
        omitted_components: 0,
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
    const root = await mkdtemp(join(tmpdir(), "rea-android-invalid-"));
    const path = join(root, "fixture.zip");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("one.js", new TextReader("one"));
    await writeFile(path, await writer.close());
    const inventory = parseEvidence(
      await runProviderAnalysis(path, "inventory_artifact", {}),
    );
    expect(
      projectAndroidApplicationEvidence({ inventory_evidence: [inventory] }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
  });
});
