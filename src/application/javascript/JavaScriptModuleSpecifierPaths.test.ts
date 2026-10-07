import { describe, expect, it } from "vitest";

import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";
import { resolveArtifactPathByContext } from "./JavaScriptArtifactPathResolution.js";

const filesFor = (paths: readonly string[]) =>
  new Map<string, JavaScriptArtifactFile>(
    ["app/main.js", ...paths].map((path) => [
      path,
      {
        path,
        container_sha256: "a".repeat(64),
        sha256: "b".repeat(64),
        bytes: 0,
        inventory_artifact_id: `artifact-${path}`,
        kind: "javascript",
        unpacked: false,
        text: { included: true, value: "" },
      },
    ]),
  );

const cases = ["#", "?"].flatMap((punctuation) =>
  (["require", "import", undefined] as const).flatMap((moduleKind) =>
    (["literal", "stripped", "both"] as const).map((layout) => ({
      punctuation,
      moduleKind,
      layout,
    })),
  ),
);

describe("module specifier punctuation", () => {
  it.each(cases)(
    "resolves $moduleKind with $punctuation and $layout files",
    ({ punctuation, moduleKind, layout }) => {
      const literal = `app/dep.cjs${punctuation}literal.cjs`;
      const stripped = "app/dep.cjs";
      const files = filesFor([
        ...(layout !== "stripped" ? [literal] : []),
        ...(layout !== "literal" ? [stripped] : []),
      ]);
      const expected = moduleKind === "require" ? literal : stripped;
      const result = resolveArtifactPathByContext({
        declaredPath: `./dep.cjs${punctuation}literal.cjs`,
        sourcePath: "app/main.js",
        context: "module-specifier",
        files,
        ...(moduleKind === undefined ? {} : { moduleKind }),
      });
      expect(result).toMatchObject({
        resolution_status: files.has(expected) ? "resolved" : "not-found",
        resolved_path: files.has(expected) ? expected : null,
      });
    },
  );

  it.each(["#", "?"])(
    "keeps HTML URL suffix handling for %s",
    (punctuation) => {
      expect(
        resolveArtifactPathByContext({
          declaredPath: `./dep.cjs${punctuation}literal.cjs`,
          sourcePath: "app/main.js",
          context: "html-reference",
          files: filesFor([
            "app/dep.cjs",
            `app/dep.cjs${punctuation}literal.cjs`,
          ]),
        }),
      ).toMatchObject({
        resolution_status: "resolved",
        resolved_path: "app/dep.cjs",
      });
    },
  );
});
