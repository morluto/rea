import { describe, expect, it } from "vitest";

import { detectReferenceSourceLanguage } from "./referenceSourceClassification.js";

describe("reference source Dockerfile language detection", () => {
  it.each([
    ["DockerfileGuide.ts", "TypeScript"],
    ["nested/dockerfileHelper.py", "Python"],
    ["docs/dockerfiles.md", "Markdown"],
    ["DOCKERFILE_HELPER.JS", "JavaScript"],
    ["Dockerfile-Guide.tsx", "TSX"],
    ["DockerfileGuide.d.ts", "TypeScript"],
    ["DockerfileGuide.d.mts", "TypeScript"],
    ["DockerfileGuide.d.cts", "TypeScript"],
    ["dockerfiles", null],
    ["dockerfileHelper.unknown", null],
  ])(
    "uses the extension for unrelated prefix filename %s",
    (path, language) => {
      expect(detectReferenceSourceLanguage(path)).toBe(language);
    },
  );

  it.each([
    "Dockerfile",
    "dockerfile",
    "DOCKERFILE",
    "nested/DoCkErFiLe",
    "Dockerfile.dev",
    "Dockerfile.dev.ts",
    "nested/dockerfile.dev.ts",
    "DOCKERFILE.DEV.TS",
    "Dockerfile.",
  ])("preserves exact and dotted Dockerfile recognition for %s", (path) => {
    expect(detectReferenceSourceLanguage(path)).toBe("Dockerfile");
  });

  it.each([
    ["ordinary.ts", "TypeScript"],
    ["ordinary.TS", "TypeScript"],
    ["ordinary.d.mts", "TypeScript"],
    ["Dockerfile/main.js", "JavaScript"],
    ["README.md", "Markdown"],
    ["package.json", "JSON"],
    ["Containerfile", null],
    [".dockerfile", null],
    ["unknown", null],
  ])("preserves other filename handling for %s", (path, language) => {
    expect(detectReferenceSourceLanguage(path)).toBe(language);
  });
});
