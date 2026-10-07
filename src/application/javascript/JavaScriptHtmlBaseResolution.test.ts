import { describe, expect, it } from "vitest";
import { resolveArtifactPathByContext } from "./JavaScriptArtifactPathResolution.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
const paths = [
  "renderer/index.html",
  "assets/app.js",
  "renderer/app.js",
  "renderer/a/app.js",
  "app.js",
];
const files = new Map<string, JavaScriptArtifactFile>(
  paths.map((path) => [
    path,
    {
      path,
      container_sha256: "a".repeat(64),
      sha256: "b".repeat(64),
      bytes: 0,
      inventory_artifact_id: path,
      kind: "javascript",
      unpacked: false,
      text: { included: true, value: "" },
    },
  ]),
);
const resolve = (declaredPath: string, htmlBaseHref: string) =>
  resolveArtifactPathByContext({
    declaredPath,
    htmlBaseHref,
    sourcePath: "renderer/index.html",
    context: "html-reference",
    files,
  });
const documentUrl = "https://artifact.test/renderer/index.html";
describe("HTML base href URL components", () => {
  it.each([
    "/assets/?cache=/wrong/",
    "/assets/#/wrong/",
    "/assets/index.html?cache=/wrong/",
  ])("ignores query and fragment path-looking characters in %s", (base) => {
    expect(
      new URL(
        "app.js",
        new URL(base, "https://artifact.test/renderer/index.html"),
      ).pathname,
    ).toBe("/assets/app.js");
    expect(resolve("app.js", base)).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "assets/app.js",
    });
  });
  it.each(["https://external.test/", "//external.test/"])(
    "keeps root-relative references external when their base is %s",
    (base) => {
      expect(resolve("/assets/app.js", base)).toMatchObject({
        resolution_status: "external",
        resolved_path: null,
      });
    },
  );
});
describe("HTML base href dot segments", () => {
  it.each([
    [".", "renderer/app.js"],
    ["./", "renderer/app.js"],
    ["a/.", "renderer/a/app.js"],
    ["a/..", "renderer/app.js"],
    ["..", "app.js"],
  ])(
    "resolves %s against the document directory like the URL parser",
    (base, expected) => {
      // A relative reference resolves against the base URL's directory, which
      // drops a trailing "." or ".." segment instead of stepping through it.
      expect(
        decodeURIComponent(
          new URL("app.js", new URL(base, documentUrl)).pathname,
        ).replace(/^\/+/, ""),
      ).toBe(expected);
      expect(resolve("app.js", base)).toMatchObject({
        resolution_status: "resolved",
        resolved_path: expected,
      });
    },
  );
});
describe("HTML base href path syntax", () => {
  it.each(["%2e%2e/secret/", "/a/%2e%2e/", "/a\\b/", "a\0b"])(
    "rejects base href %j with the same admission rules a declared path gets",
    (base) => {
      const outcome = resolve("app.js", base);
      expect(outcome.resolution_status).toBe("rejected");
      expect(outcome.limitations[0]).toContain(
        "not admitted for canonical artifact paths",
      );
    },
  );
  it("still confines a base href that escapes the artifact root", () => {
    expect(resolve("app.js", "/a/../../secret/")).toMatchObject({
      resolution_status: "rejected",
      limitations: [
        "The resolved candidate escapes the canonical artifact root.",
      ],
    });
  });
  it("reports an external base href as external rather than malformed", () => {
    expect(resolve("app.js", "https://external.test/%2e%2e/")).toMatchObject({
      resolution_status: "external",
      resolved_path: null,
    });
  });
});
