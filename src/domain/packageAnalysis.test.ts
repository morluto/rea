import { describe, expect, it } from "vitest";

import {
  classifyResource,
  detectPackageFormat,
  hasValidSignature,
  isConfigurationResource,
  isManifestResource,
  packageManifestSchema,
  resourcesByType,
  totalResourceSize,
  type PackageManifest,
} from "./packageAnalysis.js";

describe("package analysis", () => {
  it("detects package format from extension", () => {
    expect(detectPackageFormat("app.msix")).toBe("msix");
    expect(detectPackageFormat("installer.msi")).toBe("msi");
    expect(detectPackageFormat("app.appx")).toBe("appx");
    expect(detectPackageFormat("app.zip")).toBeNull();
  });

  it("identifies manifest resources", () => {
    expect(isManifestResource("AppXManifest.xml")).toBe(true);
    expect(isManifestResource("resources.pri")).toBe(false);
  });

  it("identifies configuration resources", () => {
    expect(isConfigurationResource("settings.xml")).toBe(true);
    expect(isConfigurationResource("config.json")).toBe(true);
    expect(isConfigurationResource("app.exe")).toBe(false);
  });

  it("classifies resources by path", () => {
    expect(classifyResource("AppXManifest.xml")).toBe("manifest");
    expect(classifyResource("icon.png")).toBe("icon");
    expect(classifyResource("settings.xml")).toBe("configuration");
    expect(classifyResource("cert.cer")).toBe("certificate");
    expect(classifyResource("app.exe")).toBe("executable");
    expect(classifyResource("lib.dll")).toBe("library");
    expect(classifyResource("data.bin")).toBe("other");
  });

  const validManifest: PackageManifest = {
    format: "msix",
    name: "TestApp",
    publisher: "CN=TestPublisher",
    version: "1.0.0.0",
    architecture: "x64",
    resources: [
      {
        path: "AppXManifest.xml",
        type: "manifest",
        size: 1000,
        digest: "a".repeat(64),
      },
      { path: "icon.png", type: "icon", size: 5000, digest: "b".repeat(64) },
      {
        path: "app.exe",
        type: "executable",
        size: 50000,
        digest: "c".repeat(64),
      },
    ],
    signature: {
      is_signed: true,
      signer_subject: "CN=TestPublisher",
      certificate_thumbprint: "abc123",
      is_valid: true,
      is_timestamped: true,
      timestamp_signer: "CN=Timestamp",
    },
    is_framework: false,
    dependencies: ["Microsoft.VCLibs.14.00"],
    capabilities: ["internetClient", "localNetwork"],
  };

  it("validates a well-formed manifest", () => {
    const result = packageManifestSchema.safeParse(validManifest);
    expect(result.success).toBe(true);
  });

  it("filters resources by type", () => {
    const icons = resourcesByType(validManifest, "icon");
    expect(icons).toHaveLength(1);
    expect(icons[0]!.path).toBe("icon.png");
  });

  it("computes total resource size", () => {
    expect(totalResourceSize(validManifest)).toBe(56000);
  });

  it("checks valid signature", () => {
    expect(hasValidSignature(validManifest)).toBe(true);
    const unsigned: PackageManifest = {
      ...validManifest,
      signature: { ...validManifest.signature, is_valid: false },
    };
    expect(hasValidSignature(unsigned)).toBe(false);
  });
});
