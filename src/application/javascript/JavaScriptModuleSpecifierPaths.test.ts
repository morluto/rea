import { describe, expect, it } from "vitest";

import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
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

describe("module specifier punctuation", () => {
  it.each(["#", "?"])(
    "keeps CommonJS punctuation and strips URL suffixes for ESM (%s)",
    (punctuation) => {
      const literal = `app/dep.cjs${punctuation}literal.cjs`;
      const stripped = "app/dep.cjs";
      const commonJs = resolveArtifactPathByContext({
        declaredPath: `./dep.cjs${punctuation}literal.cjs`,
        sourcePath: "app/main.js",
        context: "module-specifier",
        files: filesFor([literal, stripped]),
        moduleKind: "require",
      });
      expect(commonJs).toMatchObject({
        resolution_status: "resolved",
        resolved_path: literal,
      });

      const esm = resolveArtifactPathByContext({
        declaredPath: `./dep.cjs${punctuation}literal.cjs`,
        sourcePath: "app/main.js",
        context: "module-specifier",
        files: filesFor([literal, stripped]),
        moduleKind: "import",
      });
      expect(esm).toMatchObject({
        resolution_status: "resolved",
        resolved_path: stripped,
      });

      const noStrippedTarget = resolveArtifactPathByContext({
        declaredPath: `./dep.cjs${punctuation}literal.cjs`,
        sourcePath: "app/main.js",
        context: "module-specifier",
        files: filesFor([literal]),
        moduleKind: "import",
      });
      expect(noStrippedTarget).toMatchObject({
        resolution_status: "not-found",
        resolved_path: null,
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
