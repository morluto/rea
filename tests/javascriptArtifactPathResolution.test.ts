import { describe, expect, it } from "vitest";

import {
  resolveArtifactPathByContext,
  type ResolveArtifactPathInput,
} from "../src/application/JavaScriptArtifactPathResolution.js";
import type { JavaScriptArtifactFile } from "../src/application/JavaScriptArtifactFiles.js";
import { analyzeJavaScriptStaticSource } from "../src/domain/javascriptStaticAnalysis.js";

describe("contextual JavaScript artifact path resolution", () => {
  it.each([
    ["main.js", "app/main.js"],
    ["./main.js", "app/main.js"],
    ["src/main", "app/src/main.cjs"],
    ["entry", "app/entry/start.mjs"],
    ["fallback", "app/fallback/index.ts"],
  ])("resolves package entrypoint %s", (declaredPath, expected) => {
    const files = fileMap([
      file("app/package.json", "root"),
      file("app/main.js", "root"),
      file("app/src/main.cjs", "root"),
      file("app/entry/package.json", "root", '{"main":"start"}'),
      file("app/entry/start.mjs", "root"),
      file("app/fallback/index.ts", "root"),
    ]);

    expect(
      resolve({
        declaredPath,
        sourcePath: "app/package.json",
        context: "package-entrypoint",
        files,
      }),
    ).toMatchObject({
      resolution_context: "package-entrypoint",
      resolution_status: "resolved",
      resolved_path: expected,
      limitations: [],
    });
  });

  it("resolves dirname-derived bare paths but keeps bare module specifiers external", () => {
    const files = fileMap([
      file("app/main.js", "root"),
      file("app/preload.js", "root"),
    ]);
    const base = {
      declaredPath: "preload.js",
      sourcePath: "app/main.js",
      files,
    } as const;

    expect(
      resolve({ ...base, context: "filesystem-expression" }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "app/preload.js",
    });
    expect(resolve({ ...base, context: "module-specifier" })).toMatchObject({
      resolution_status: "external",
      resolved_path: null,
    });
  });

  it("applies document and base-href semantics to HTML references", () => {
    const files = fileMap([
      file("renderer/index.html", "root"),
      file("assets/app.js", "root"),
      file("renderer/local.js", "root"),
    ]);

    expect(
      resolve({
        declaredPath: "app.js?v=1",
        sourcePath: "renderer/index.html",
        context: "html-reference",
        htmlBaseHref: "/assets/",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "assets/app.js",
    });
    expect(
      resolve({
        declaredPath: "./local.js",
        sourcePath: "renderer/index.html",
        context: "html-reference",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "renderer/local.js",
    });
    expect(
      resolve({
        declaredPath: "file:///assets/app.js#entry",
        sourcePath: "main.js",
        context: "module-specifier",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "assets/app.js",
    });
  });

  it.each(["node:fs", "electron", "../../escape.js", "%2e%2e/escape.js"])(
    "fails closed for unsafe or external module declaration %s",
    (declaredPath) => {
      const result = resolve({
        declaredPath,
        sourcePath: "app/main.js",
        context: "module-specifier",
        files: fileMap([file("app/main.js", "root")]),
      });
      expect(result.resolved_path).toBeNull();
      expect(["external", "rejected"]).toContain(result.resolution_status);
      expect(result.limitations.length).toBeGreaterThan(0);
    },
  );

  it("does not cross nested ASAR container identities", () => {
    const files = fileMap([
      file("app.asar/main.js", "asar-a"),
      file("app.asar/preload.js", "asar-b"),
    ]);

    expect(
      resolve({
        declaredPath: "preload.js",
        sourcePath: "app.asar/main.js",
        context: "filesystem-expression",
        files,
      }),
    ).toMatchObject({ resolution_status: "not-found", resolved_path: null });
  });

  it("keeps an inventoried but unreadable directory package unavailable", () => {
    const files = fileMap([
      file("app/package.json", "root"),
      file("app/entry/package.json", "root", null),
    ]);

    expect(
      resolve({
        declaredPath: "entry",
        sourcePath: "app/package.json",
        context: "package-entrypoint",
        files,
      }),
    ).toMatchObject({
      resolution_status: "unavailable",
      resolved_path: null,
      limitations: [expect.stringContaining("text is unavailable")],
    });
  });

  it("resolves nearest inventoried bare packages with import/require conditions", () => {
    const files = fileMap([
      file("app/src/consumer.js", "root"),
      file(
        "app/node_modules/fixture/package.json",
        "root",
        JSON.stringify({
          exports: {
            ".": {
              import: "./esm.mjs",
              require: "./cjs.cjs",
              default: "./fallback.js",
            },
          },
        }),
      ),
      file("app/node_modules/fixture/esm.mjs", "root"),
      file("app/node_modules/fixture/cjs.cjs", "root"),
      file("app/node_modules/fixture/fallback.js", "root"),
      file("app/node_modules/fixture/hidden.js", "root"),
      file("app/node_modules/fs/index.js", "root"),
    ]);

    expect(
      resolve({
        declaredPath: "fixture",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "import",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "app/node_modules/fixture/esm.mjs",
    });
    expect(
      resolve({
        declaredPath: "fixture",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "app/node_modules/fixture/cjs.cjs",
    });
    expect(
      resolve({
        declaredPath: "fs",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({ resolution_status: "external", resolved_path: null });
    expect(
      resolve({
        declaredPath: "fixture/hidden.js",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "import",
        files,
      }),
    ).toMatchObject({
      resolution_status: "external",
      resolved_path: null,
      limitations: [expect.stringContaining("subpaths remain unresolved")],
    });
  });

  it("retains CommonJS and ESM file-base identity during inert extraction", () => {
    const analysis = analyzeJavaScriptStaticSource(
      `
        new BrowserWindow({ webPreferences: {
          preload: path.resolve(__dirname, "preload.cjs")
        }});
        new BrowserWindow({ webPreferences: {
          preload: fileURLToPath(new URL("./preload.mjs", import.meta.url))
        }});
        new BrowserWindow({ webPreferences: {
          preload: path.join(path.dirname(__filename), "legacy-preload.js")
        }});
        new BrowserWindow({ webPreferences: {
          preload: new URL("./remote-base.js", location.href)
        }});
        window.loadURL("file:///renderer/index.html");
      `,
      {
        maxAstNodes: 10_000,
        maxFindings: 100,
        maxModules: 100,
        deadline: Number.POSITIVE_INFINITY,
        now: () => 0,
      },
    );

    expect(analysis.role_paths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "preload.cjs",
          resolution_context: "filesystem-expression",
        }),
        expect.objectContaining({
          path: "./preload.mjs",
          resolution_context: "filesystem-expression",
        }),
        expect.objectContaining({
          path: "legacy-preload.js",
          resolution_context: "filesystem-expression",
        }),
        expect.objectContaining({
          path: "file:///renderer/index.html",
          resolution_context: "module-specifier",
        }),
      ]),
    );
    expect(analysis.electron.browser_windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          preload_path: "preload.cjs",
          preload_resolution_context: "filesystem-expression",
        }),
        expect.objectContaining({
          preload_path: "./preload.mjs",
          preload_resolution_context: "filesystem-expression",
        }),
      ]),
    );
    expect(analysis.role_paths).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "./remote-base.js" }),
      ]),
    );
  });
});

const resolve = (input: ResolveArtifactPathInput) =>
  resolveArtifactPathByContext(input);

const fileMap = (files: readonly JavaScriptArtifactFile[]) =>
  new Map(files.map((value) => [value.path, value]));

const file = (
  path: string,
  container: string,
  text: string | null = "",
): JavaScriptArtifactFile => ({
  path,
  container_sha256: container.padEnd(64, "0").slice(0, 64),
  sha256: path.padEnd(64, "0").slice(0, 64),
  bytes: text?.length ?? 0,
  inventory_artifact_id: `artifact-${path}`,
  kind: path.endsWith("package.json") ? "package-json" : "javascript",
  unpacked: false,
  text:
    text === null
      ? { included: false, reason: "file-limit" }
      : { included: true, value: text },
});
