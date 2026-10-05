import { describe, expect, it } from "vitest";
import { resolveArtifactPathByContext } from "./JavaScriptArtifactPathResolution.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";
const paths = ["renderer/index.html", "assets/app.js"];
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
