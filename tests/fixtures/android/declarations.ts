import { createEvidence } from "../../../src/domain/evidence.js";
import type { AndroidPackageDeclarations } from "../../../src/domain/android/androidDeclarationComparison.js";
import { parseAndroidManifestComponents } from "../../../src/android/AndroidManifestComponents.js";

/** Canonical inspection facts built from explicit XML; no real JADX engine. */
export const androidDeclarationFacts = (
  declarations = '<activity android:name=".Main" android:exported="false"/>',
): AndroidPackageDeclarations => {
  const text = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="example.fixture"><application>${declarations}</application></manifest>`;
  return {
    engine: {
      name: "jadx",
      version: "fixture",
      artifact_sha256: "e".repeat(64),
      source_revision: null,
      worker_count: 1,
      heap_limit_mib: null,
    },
    package_name: "example.fixture",
    version_name: "1.0",
    version_code: "1",
    min_sdk: "23",
    target_sdk: "35",
    permissions: ["android.permission.INTERNET"],
    manifest: {
      status: "complete",
      text,
      reported_total_bytes: Buffer.byteLength(text),
    },
    components: parseAndroidManifestComponents(text, "complete", "35", "23"),
    class_count: 1,
    resource_count: 0,
    signature_verification: "not_performed",
  };
};

export const androidDeclarationEvidence = (
  result = androidDeclarationFacts(),
  side: "left" | "right" = "left",
) =>
  createEvidence(
    {
      path: `/retained/${side}.apk`,
      sha256: (side === "left" ? "a" : "b").repeat(64),
      format: "apk",
    },
    {
      id: "android-declaration-fixture",
      name: "Canonical Android fixture",
      version: "1",
    },
    {
      operation: "inspect_android_package",
      parameters: { path: `./selected-${side}.apk` },
      result,
      limitations: [
        "Fabricated inspection envelope with production manifest parser; no real JADX execution.",
      ],
      confidence: "observed",
    },
  );
