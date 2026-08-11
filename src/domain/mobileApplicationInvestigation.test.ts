import { describe, expect, it } from "vitest";

import {
  classifyMobileResource,
  detectMobileFormat,
  detectPlatform,
  getAllArchitectures,
  hasInternetPermission,
  mobileArtifactManifestSchema,
  nativeLibsByArchitecture,
  type MobileArtifactManifest,
  type AndroidManifest,
  type SigningInfo,
  type NativeLibrary,
  type MobileResource,
} from "./mobileApplicationInvestigation.js";

describe("mobile application investigation", () => {
  it("detects mobile format from extension", () => {
    expect(detectMobileFormat("app.apk")).toBe("apk");
    expect(detectMobileFormat("app.aab")).toBe("aab");
    expect(detectMobileFormat("app.ipa")).toBe("ipa");
    expect(detectMobileFormat("classes.dex")).toBe("dex");
    expect(detectMobileFormat("lib.so")).toBe("native_lib");
    expect(detectMobileFormat("readme.txt")).toBeNull();
  });

  it("detects platform from format", () => {
    expect(detectPlatform("apk")).toBe("android");
    expect(detectPlatform("aab")).toBe("android");
    expect(detectPlatform("dex")).toBe("android");
    expect(detectPlatform("ipa")).toBe("ios");
    expect(detectPlatform("native_lib")).toBe("cross_platform");
  });

  it("classifies resources by path", () => {
    expect(classifyMobileResource("res/layout/main.xml")).toBe("layout");
    expect(classifyMobileResource("res/drawable/icon.png")).toBe("drawable");
    expect(classifyMobileResource("assets/data.json")).toBe("asset");
    expect(classifyMobileResource("AndroidManifest.xml")).toBe("manifest");
    expect(classifyMobileResource("app.entitlements")).toBe("entitlements");
    expect(classifyMobileResource("lib/arm64-v8a/libnative.so")).toBe(
      "native_lib",
    );
    expect(classifyMobileResource("unknown.xyz")).toBe("other");
  });

  const androidManifest: AndroidManifest = {
    package_name: "com.example.app",
    version_name: "1.0.0",
    version_code: 1,
    min_sdk: 21,
    target_sdk: 34,
    permissions: ["android.permission.INTERNET", "android.permission.CAMERA"],
    activities: ["MainActivity"],
    services: ["BackgroundService"],
    receivers: [],
    providers: [],
  };

  const signing: SigningInfo = {
    is_signed: true,
    signer_identity: "CN=TestSigner",
    certificate_fingerprint: "abc123",
    signature_scheme: "v2",
    is_debuggable: false,
  };

  const nativeLibs: NativeLibrary[] = [
    {
      path: "lib/arm64-v8a/libnative.so",
      architecture: "arm64-v8a",
      size: 100000,
      digest: "a".repeat(64),
    },
    {
      path: "lib/armeabi-v7a/libnative.so",
      architecture: "armeabi-v7a",
      size: 90000,
      digest: "b".repeat(64),
    },
  ];

  const resources: MobileResource[] = [
    { path: "res/layout/main.xml", type: "layout", size: 1000 },
    { path: "res/drawable/icon.png", type: "drawable", size: 5000 },
  ];

  const validManifest: MobileArtifactManifest = {
    format: "apk",
    platform: "android",
    app_name: "TestApp",
    android_manifest: androidManifest,
    ios_manifest: null,
    signing,
    resources,
    native_libraries: nativeLibs,
    total_size: 5000000,
    architectures: ["arm64-v8a", "armeabi-v7a"],
  };

  it("validates a well-formed manifest", () => {
    const result = mobileArtifactManifestSchema.safeParse(validManifest);
    expect(result.success).toBe(true);
  });

  it("filters native libs by architecture", () => {
    const arm64 = nativeLibsByArchitecture(validManifest, "arm64-v8a");
    expect(arm64).toHaveLength(1);
    expect(arm64[0]!.architecture).toBe("arm64-v8a");
  });

  it("checks internet permission", () => {
    expect(hasInternetPermission(validManifest)).toBe(true);
    const noInternet: MobileArtifactManifest = {
      ...validManifest,
      android_manifest: { ...androidManifest, permissions: [] },
    };
    expect(hasInternetPermission(noInternet)).toBe(false);
  });

  it("gets all architectures", () => {
    const archs = getAllArchitectures(validManifest);
    expect(archs).toHaveLength(2);
    expect(archs).toContain("arm64-v8a");
    expect(archs).toContain("armeabi-v7a");
  });
});
