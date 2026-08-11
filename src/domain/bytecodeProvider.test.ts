import { describe, expect, it } from "vitest";

import {
  analyzeBytecodeArtifacts,
  bytecodeAnalysisSchema,
  classifyProvenance,
  detectArtifactFormat,
  detectBytecodeFamily,
  type BytecodeArtifact,
} from "./bytecodeProvider.js";

describe("bytecode provider", () => {
  it("detects JVM family from extensions", () => {
    expect(detectBytecodeFamily("App.class")).toBe("jvm");
    expect(detectBytecodeFamily("app.jar")).toBe("jvm");
    expect(detectBytecodeFamily("webapp.war")).toBe("jvm");
    expect(detectBytecodeFamily("app.ear")).toBe("jvm");
  });

  it("detects Python family from extensions", () => {
    expect(detectBytecodeFamily("module.pyc")).toBe("python");
    expect(detectBytecodeFamily("module.pyo")).toBe("python");
    expect(detectBytecodeFamily("package.whl")).toBe("python");
    expect(detectBytecodeFamily("app.pyz")).toBe("python");
    expect(detectBytecodeFamily("app.zipapp")).toBe("python");
  });

  it("returns null for unknown extensions", () => {
    expect(detectBytecodeFamily("readme.txt")).toBeNull();
    expect(detectBytecodeFamily("script.js")).toBeNull();
  });

  it("detects artifact format from path", () => {
    expect(detectArtifactFormat("App.class")).toBe("class");
    expect(detectArtifactFormat("lib.jar")).toBe("jar");
    expect(detectArtifactFormat("web.war")).toBe("war");
    expect(detectArtifactFormat("mod.pyc")).toBe("pyc");
    expect(detectArtifactFormat("pkg.whl")).toBe("whl");
    expect(detectArtifactFormat("unknown.xyz")).toBeNull();
  });

  it("classifies standard library provenance", () => {
    expect(classifyProvenance("/usr/lib/stdlib", "java.lang.String")).toBe(
      "standard_library",
    );
    expect(
      classifyProvenance("/lib/python3.10/site-packages/numpy", "__init__"),
    ).toBe("standard_library");
  });

  it("classifies generated provenance", () => {
    expect(classifyProvenance("/build/generated/src", "GeneratedClass")).toBe(
      "generated",
    );
    expect(
      classifyProvenance("/__pycache__/module.cpython-310.pyc", "module"),
    ).toBe("generated");
  });

  it("classifies vendored provenance", () => {
    expect(classifyProvenance("/vendor/libs/lib.jar", "VendorLib")).toBe(
      "vendored",
    );
    expect(classifyProvenance("/third_party/pkg/module.pyc", "module")).toBe(
      "vendored",
    );
  });

  it("classifies application provenance", () => {
    expect(classifyProvenance("/src/main/App.java", "com.example.App")).toBe(
      "application",
    );
    expect(classifyProvenance("/src/app.py", "main")).toBe("application");
  });

  it("analyzes bytecode artifacts and computes summary", () => {
    const artifacts: BytecodeArtifact[] = [
      {
        path: "src/App.class",
        family: "jvm",
        format: "class",
        size: 1000,
        digest: "a".repeat(64),
        symbols: [
          {
            name: "com.example.App",
            raw_location: "0x1000",
            kind: "class",
            bytecode_version: 52,
            provenance: "application",
            is_public: true,
          },
          {
            name: "java.lang.String",
            raw_location: "0x2000",
            kind: "class",
            bytecode_version: 52,
            provenance: "standard_library",
            is_public: true,
          },
        ],
        is_standard_library: false,
        is_generated: false,
        is_vendored: false,
      },
      {
        path: "lib/generated/Generated.class",
        family: "jvm",
        format: "class",
        size: 500,
        digest: "b".repeat(64),
        symbols: [
          {
            name: "GeneratedClass",
            raw_location: "0x3000",
            kind: "class",
            bytecode_version: 52,
            provenance: "generated",
            is_public: false,
          },
        ],
        is_standard_library: false,
        is_generated: true,
        is_vendored: false,
      },
    ];
    const result = analyzeBytecodeArtifacts(artifacts, "jvm");
    expect(result.family).toBe("jvm");
    expect(result.total_symbols).toBe(3);
    expect(result.application_symbols).toBe(1);
    expect(result.standard_library_symbols).toBe(1);
    expect(result.generated_symbols).toBe(1);
    expect(result.vendored_symbols).toBe(0);

    // Validate schema
    const parsed = bytecodeAnalysisSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });
});
