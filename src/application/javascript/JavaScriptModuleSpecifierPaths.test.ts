import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import { resolveArtifactPathByContext } from "./JavaScriptArtifactPathResolution.js";
import { analyzeJavaScriptApplication } from "./JavaScriptApplicationService.js";
import { javascriptApplicationAnalysisResultSchema } from "../../domain/javascript/javascriptApplicationAnalysis.js";

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

describe("ESM module URL decoding", () => {
  it.each([
    ["./plain.mjs", "plain.mjs"],
    ["./space%20name.mjs", "space name.mjs"],
    ["./pr%C3%A9load.mjs", "préload.mjs"],
    ["./name%3F%23.mjs", "name?#.mjs"],
    ["./percent%2520.mjs?cache=1#v2", "percent%20.mjs"],
  ])(
    "points %s imports to the file loaded by Node",
    async (specifier, target) => {
      const root = await createTestTempDirectory("rea-module-url-");
      const main = join(root, "main.mjs");
      await writeFile(
        main,
        `import value from ${JSON.stringify(specifier)}; console.log(value);`,
      );
      await writeFile(
        join(root, target),
        `export default ${JSON.stringify(target)};`,
      );
      const encoded = specifier.slice(2).split("?", 1)[0]?.split("#", 1)[0];
      if (encoded !== undefined && encoded !== target)
        await writeFile(join(root, encoded), 'export default "encoded decoy";');
      const native = await promisify(execFile)(process.execPath, [main], {
        timeout: 5_000,
      });
      expect(native.stdout.trim()).toBe(target);

      const result = await analyzeJavaScriptApplication({
        input_path: root,
        format: "directory",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      const { graph } = javascriptApplicationAnalysisResultSchema.parse(
        result.value.normalized_result,
      );
      const imports = graph.edges.filter(
        (edge) =>
          edge.relation === "imports" &&
          edge.properties.specifier === specifier,
      );
      expect(imports.length).toBeGreaterThan(0);
      for (const edge of imports)
        expect(edge.properties.resolved_path).toBe(target);
    },
  );

  it("preserves CommonJS literal percent names", () => {
    expect(
      resolveArtifactPathByContext({
        declaredPath: "./space%20name.cjs",
        sourcePath: "app/main.js",
        context: "module-specifier",
        moduleKind: "require",
        files: filesFor(["app/space%20name.cjs", "app/space name.cjs"]),
      }),
    ).toMatchObject({
      resolved_path: "app/space%20name.cjs",
      resolution_status: "resolved",
    });
  });

  it.each(["./invalid%.mjs", "./invalid%C3.mjs", "./nul%00.mjs"])(
    "rejects malformed or NUL URL %s",
    (declaredPath) => {
      expect(
        resolveArtifactPathByContext({
          declaredPath,
          sourcePath: "app/main.js",
          context: "module-specifier",
          moduleKind: "import",
          files: filesFor([`app/${declaredPath.slice(2)}`]),
        }),
      ).toMatchObject({ resolved_path: null, resolution_status: "rejected" });
    },
  );
});
