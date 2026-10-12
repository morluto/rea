import { describe, expect, it } from "vitest";

import {
  resolveArtifactPathByContext,
  type ResolveArtifactPathInput,
} from "./JavaScriptArtifactPathResolution.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import { artifactLocalIdentity } from "./JavaScriptArtifactGraphContext.js";
import { applicationNodeIdentitySchema } from "../../domain/javascript/javascriptApplicationEvidenceSchemas.js";
import { analyzeJavaScriptStaticSource } from "../../domain/javascript/javascriptStaticAnalysis.js";

describe("artifact URI scheme classification", () => {
  it.each(["html-reference", "module-specifier", "url-reference"] as const)(
    "keeps digit-bearing schemes external in %s even when a local file matches",
    (context) => {
      const files = fileMap([
        file("index.html", "root"),
        file("web3:app.js", "root"),
      ]);
      expect(
        resolve({
          declaredPath: "web3:app.js",
          sourcePath: "index.html",
          context,
          files,
        }),
      ).toMatchObject({ resolution_status: "external", resolved_path: null });
    },
  );

  it("keeps references under a digit-bearing external base href external", () => {
    const files = fileMap([
      file("index.html", "root"),
      file("web3:assets/app.js", "root"),
    ]);
    expect(
      resolve({
        declaredPath: "app.js",
        sourcePath: "index.html",
        context: "html-reference",
        htmlBaseHref: "web3:assets/",
        files,
      }),
    ).toMatchObject({ resolution_status: "external", resolved_path: null });
  });
});

describe("artifact-local graph identity", () => {
  it("preserves complete long namespace and key values", () => {
    const digest = "a".repeat(64);
    const namespacePrefix = "n".repeat(512);
    const keyPrefix = "k".repeat(4_096);
    const first = artifactLocalIdentity(
      digest,
      `${namespacePrefix}a`,
      `${keyPrefix}a`,
    );
    const second = artifactLocalIdentity(
      digest,
      `${namespacePrefix}b`,
      `${keyPrefix}b`,
    );

    expect(applicationNodeIdentitySchema.parse(first)).toEqual(first);
    expect(applicationNodeIdentitySchema.parse(second)).toEqual(second);
    expect(first).not.toEqual(second);
  });
});

describe("loader-owned path lookup", () => {
  it("keeps relative ESM imports exact", () => {
    const files = fileMap([
      file("app/entry.mjs", "root"),
      file("app/feature.js", "root"),
      file("app/directory/index.js", "root"),
      file("app/feature.js.js", "root"),
    ]);
    for (const declaredPath of ["./feature", "./directory"]) {
      expect(
        resolve({
          declaredPath,
          sourcePath: "app/entry.mjs",
          context: "module-specifier",
          moduleKind: "import",
          files,
        }),
      ).toMatchObject({ resolution_status: "not-found", resolved_path: null });
    }
    expect(
      resolve({
        declaredPath: "./feature.js",
        sourcePath: "app/entry.mjs",
        context: "module-specifier",
        moduleKind: "import",
        files,
      }),
    ).toMatchObject({ resolved_path: "app/feature.js" });
  });

  it("does not use .cjs as an extensionless CommonJS probe", () => {
    const files = fileMap([
      file("app/entry.cjs", "root"),
      file("app/feature.cjs", "root"),
    ]);
    expect(
      resolve({
        declaredPath: "./feature",
        sourcePath: "app/entry.cjs",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({ resolution_status: "not-found", resolved_path: null });
    expect(
      resolve({
        declaredPath: "./feature.cjs",
        sourcePath: "app/entry.cjs",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({ resolved_path: "app/feature.cjs" });
  });

  it("treats an empty package main as absent and resolves the root index", () => {
    const files = fileMap([
      file("app/src/entry.cjs", "root"),
      file("app/node_modules/fixture/package.json", "root", '{"main":""}'),
      file("app/node_modules/fixture/index.js", "root"),
    ]);
    expect(
      resolve({
        declaredPath: "fixture",
        sourcePath: "app/src/entry.cjs",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "app/node_modules/fixture/index.js",
    });
  });

  it.each(["import", "require"] as const)(
    "limits %s package-main probes to Node's file extensions",
    (moduleKind) => {
      const files = fileMap([
        file("app/src/entry.js", "root"),
        file(
          "app/node_modules/fixture/package.json",
          "root",
          '{"main":"main"}',
        ),
        file("app/node_modules/fixture/main.cjs", "root"),
        file("app/node_modules/fixture/index.mjs", "root"),
      ]);
      expect(
        resolve({
          declaredPath: "fixture",
          sourcePath: "app/src/entry.js",
          context: "module-specifier",
          moduleKind,
          files,
        }),
      ).toMatchObject({ resolution_status: "not-found", resolved_path: null });
    },
  );

  it.each(["import", "require"] as const)(
    "does not recursively resolve a nested package from a %s package main",
    (moduleKind) => {
      const files = fileMap([
        file("app/src/entry.js", "root"),
        file("app/node_modules/fixture/package.json", "root", '{"main":"sub"}'),
        file(
          "app/node_modules/fixture/sub/package.json",
          "root",
          '{"main":"other"}',
        ),
        file("app/node_modules/fixture/sub/other.js", "root"),
      ]);
      expect(
        resolve({
          declaredPath: "fixture",
          sourcePath: "app/src/entry.js",
          context: "module-specifier",
          moduleKind,
          files,
        }),
      ).toMatchObject({ resolution_status: "not-found", resolved_path: null });
    },
  );

  it("still rejects non-string package main metadata", () => {
    expect(
      resolve({
        declaredPath: "./package",
        sourcePath: "app/entry.js",
        context: "filesystem-expression",
        files: fileMap([
          file("app/entry.js", "root"),
          file("app/package/package.json", "root", '{"main":false}'),
          file("app/package/index.js", "root"),
        ]),
      }),
    ).toMatchObject({ resolution_status: "unavailable", resolved_path: null });
  });
});

describe("logical path identity", () => {
  it("resolves an NFD relative import to the NFC inventory path and rejects a root escape", () => {
    const nfc = "caf\u00e9".normalize("NFC");
    const nfd = nfc.normalize("NFD");
    const files = fileMap([
      file("dir/index.js", "root"),
      file(`dir/${nfc}.js`, "root"),
    ]);
    expect(
      resolve({
        declaredPath: `./${nfd}.js`,
        sourcePath: "dir/index.js",
        context: "module-specifier",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: `dir/${nfc}.js`,
    });
    expect(
      resolve({
        declaredPath: "../escape.js",
        sourcePath: "index.js",
        context: "module-specifier",
        files,
      }),
    ).toMatchObject({ resolution_status: "rejected", resolved_path: null });
  });
});

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

  it("resolves inventoried paths longer than the former character ceiling", () => {
    const declaredPath = `./${"a".repeat(5_000)}.js`;
    const expectedPath = `app/${declaredPath.slice(2)}`;
    const files = fileMap([
      file("app/consumer.js", "root"),
      file(expectedPath, "root"),
    ]);

    expect(
      resolve({
        declaredPath,
        sourcePath: "app/consumer.js",
        context: "module-specifier",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: expectedPath,
      limitations: [],
    });
  });
});

describe("contextual JavaScript package path resolution", () => {
  it("follows package entrypoints beyond the former recursion ceiling", () => {
    const files = fileMap([
      file("app/consumer.js", "root"),
      file(
        "app/node_modules/pkg-1/package.json",
        "root",
        '{"main":"../pkg-2"}',
      ),
      file(
        "app/node_modules/pkg-2/package.json",
        "root",
        '{"main":"../pkg-3"}',
      ),
      file(
        "app/node_modules/pkg-3/package.json",
        "root",
        '{"main":"../pkg-4"}',
      ),
      file(
        "app/node_modules/pkg-4/package.json",
        "root",
        '{"main":"../pkg-5"}',
      ),
      file(
        "app/node_modules/pkg-5/package.json",
        "root",
        '{"main":"../pkg-6"}',
      ),
      file(
        "app/node_modules/pkg-6/package.json",
        "root",
        '{"main":"entry.js"}',
      ),
      file("app/node_modules/pkg-6/entry.js", "root"),
    ]);

    expect(
      resolve({
        declaredPath: "pkg-1",
        sourcePath: "app/consumer.js",
        context: "module-specifier",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "app/node_modules/pkg-6/entry.js",
      limitations: [],
    });
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
      limitations: [
        expect.stringContaining("declares no exports target for subpath"),
      ],
    });
  });
});

describe("package exports subpath resolution", () => {
  it("resolves exact subpath keys through import and require conditions", () => {
    const files = fileMap([
      file("app/src/consumer.js", "root"),
      file(
        "app/node_modules/fixture/package.json",
        "root",
        JSON.stringify({
          exports: {
            ".": "./index.cjs",
            "./parser": {
              import: "./parser.mjs",
              require: "./parser.cjs",
              default: "./fallback.js",
            },
          },
        }),
      ),
      file("app/node_modules/fixture/index.cjs", "root"),
      file("app/node_modules/fixture/parser.mjs", "root"),
      file("app/node_modules/fixture/parser.cjs", "root"),
      file("app/node_modules/fixture/fallback.js", "root"),
    ]);

    expect(
      resolve({
        declaredPath: "fixture/parser",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "import",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "app/node_modules/fixture/parser.mjs",
    });
    expect(
      resolve({
        declaredPath: "fixture/parser",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "app/node_modules/fixture/parser.cjs",
    });
  });

  it("resolves array subpath targets at their first string entry", () => {
    const files = fileMap([
      file("app/src/consumer.js", "root"),
      file(
        "app/node_modules/fixture/package.json",
        "root",
        JSON.stringify({
          exports: {
            "./parser": [{ import: "./parser.mjs" }, "./parser.cjs"],
          },
        }),
      ),
      file("app/node_modules/fixture/parser.cjs", "root"),
    ]);

    expect(
      resolve({
        declaredPath: "fixture/parser",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "app/node_modules/fixture/parser.cjs",
    });
  });

  it("resolves subpaths of scoped packages", () => {
    const files = fileMap([
      file("app/src/consumer.js", "root"),
      file(
        "app/node_modules/@scope/fixture/package.json",
        "root",
        JSON.stringify({
          exports: { "./parser": "./parser.cjs" },
        }),
      ),
      file("app/node_modules/@scope/fixture/parser.cjs", "root"),
    ]);

    expect(
      resolve({
        declaredPath: "@scope/fixture/parser",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "app/node_modules/@scope/fixture/parser.cjs",
    });
  });
});

describe("package exports subpath encapsulation", () => {
  it("keeps subpaths encapsulated when only a root target is exported", () => {
    const files = fileMap([
      file("app/src/consumer.js", "root"),
      file(
        "app/node_modules/fixture/package.json",
        "root",
        JSON.stringify({ exports: "./index.cjs" }),
      ),
      file("app/node_modules/fixture/index.cjs", "root"),
      file("app/node_modules/fixture/parser.cjs", "root"),
    ]);

    expect(
      resolve({
        declaredPath: "fixture/parser",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "external",
      resolved_path: null,
      limitations: [expect.stringContaining("a root target only")],
    });
  });

  it("blocks subpaths with an explicit null target", () => {
    const files = fileMap([
      file("app/src/consumer.js", "root"),
      file(
        "app/node_modules/fixture/package.json",
        "root",
        JSON.stringify({
          exports: { ".": "./index.cjs", "./parser": null },
        }),
      ),
      file("app/node_modules/fixture/index.cjs", "root"),
    ]);

    expect(
      resolve({
        declaredPath: "fixture/parser",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "external",
      resolved_path: null,
      limitations: [expect.stringContaining("explicit null exports target")],
    });
  });

  it("reports a missing selected subpath target without index fallback", () => {
    const files = fileMap([
      file("app/src/consumer.js", "root"),
      file(
        "app/node_modules/fixture/package.json",
        "root",
        JSON.stringify({
          exports: { "./parser": "./parser.cjs" },
        }),
      ),
      file("app/node_modules/fixture/parser/index.js", "root"),
    ]);

    expect(
      resolve({
        declaredPath: "fixture/parser",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "not-found",
      resolved_path: null,
      limitations: [expect.stringContaining("exports targets are exact files")],
    });
  });
});

describe("package subpath directory ownership", () => {
  it.each(["root", "other"])(
    "selects metadata-less package directories only in the %s container",
    (container) => {
      const files = fileMap([
        file("app/src/consumer.js", "root"),
        file("app/src/node_modules/fixture/parser.js", container),
        file("app/node_modules/fixture/package.json", "root", "{}"),
        file("app/node_modules/fixture/parser.js", "root"),
      ]);
      expect(
        resolve({
          declaredPath: "fixture/parser",
          sourcePath: "app/src/consumer.js",
          context: "module-specifier",
          moduleKind: "require",
          files,
        }),
      ).toMatchObject({
        declared_path: "fixture/parser",
        resolution_context: "module-specifier",
        resolution_status: "resolved",
        resolved_path:
          container === "root"
            ? "app/src/node_modules/fixture/parser.js"
            : "app/node_modules/fixture/parser.js",
      });
    },
  );

  it("does not mistake a package-name file or sibling prefix for a nearer directory", () => {
    const files = fileMap([
      file("app/src/consumer.js", "root"),
      file("app/src/node_modules/fixture.js", "root"),
      file("app/src/node_modules/fixture-extra/parser.js", "root"),
      file("app/node_modules/fixture/parser.js", "root"),
    ]);
    expect(
      resolve({
        declaredPath: "fixture/parser",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolved_path: "app/node_modules/fixture/parser.js",
      resolution_status: "resolved",
    });
  });

  it.each([
    ["malformed", "{", "not valid package JSON"],
    ["unavailable", null, "text is unavailable"],
  ])("preserves %s nested directory failures", (_name, text, reason) => {
    const files = fileMap([
      file("app/consumer.js", "root"),
      file("app/node_modules/fixture/package.json", "root", "{}"),
      file("app/node_modules/fixture/parser/package.json", "root", text),
    ]);
    expect(
      resolve({
        declaredPath: "fixture/parser",
        sourcePath: "app/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      declared_path: "fixture/parser",
      resolution_context: "module-specifier",
      resolved_path: null,
      resolution_status: "unavailable",
      limitations: [expect.stringContaining(reason)],
    });
  });

  it("does not recurse through a cyclic nested main during CommonJS lookup", () => {
    const files = fileMap([
      file("app/consumer.js", "root"),
      file("app/node_modules/fixture/package.json", "root", "{}"),
      file(
        "app/node_modules/fixture/parser/package.json",
        "root",
        '{"main":"."}',
      ),
    ]);
    expect(
      resolve({
        declaredPath: "fixture/parser",
        sourcePath: "app/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "not-found",
      resolved_path: null,
    });
  });
});

describe("package subpath legacy lookup and metadata failures", () => {
  it("resolves CommonJS legacy subpath files and indexes without exports", () => {
    const files = fileMap([
      file("app/src/consumer.js", "root"),
      file(
        "app/node_modules/fixture/package.json",
        "root",
        '{"main":"./index.cjs"}',
      ),
      file("app/node_modules/fixture/direct.js", "root"),
      file("app/node_modules/fixture/explicit.cjs", "root"),
      file("app/node_modules/fixture/folder/index.js", "root"),
    ]);

    expect(
      resolve({
        declaredPath: "fixture/direct",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "app/node_modules/fixture/direct.js",
    });
    expect(
      resolve({
        declaredPath: "fixture/explicit.cjs",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "app/node_modules/fixture/explicit.cjs",
    });
    expect(
      resolve({
        declaredPath: "fixture/folder",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "app/node_modules/fixture/folder/index.js",
    });
  });

  it("rejects subpath metadata that mixes subpath and condition keys", () => {
    const files = fileMap([
      file("app/src/consumer.js", "root"),
      file(
        "app/node_modules/fixture/package.json",
        "root",
        JSON.stringify({
          exports: { "./parser": "./parser.cjs", node: "./index.cjs" },
        }),
      ),
      file("app/node_modules/fixture/parser.cjs", "root"),
    ]);

    expect(
      resolve({
        declaredPath: "fixture/parser",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "rejected",
      resolved_path: null,
      limitations: [expect.stringContaining("mixes subpath keys")],
    });
  });

  it("reports malformed subpath package metadata as unavailable", () => {
    const files = fileMap([
      file("app/src/consumer.js", "root"),
      file("app/node_modules/fixture/package.json", "root", "{"),
      file("app/node_modules/fixture/parser.cjs", "root"),
    ]);

    expect(
      resolve({
        declaredPath: "fixture/parser",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "unavailable",
      resolved_path: null,
      limitations: [expect.stringContaining("not valid package JSON")],
    });
  });

  it("reports unavailable metadata text for subpath resolution", () => {
    const files = fileMap([
      file("app/src/consumer.js", "root"),
      file("app/node_modules/fixture/package.json", "root", null),
      file("app/node_modules/fixture/parser.cjs", "root"),
    ]);

    expect(
      resolve({
        declaredPath: "fixture/parser",
        sourcePath: "app/src/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "unavailable",
      resolved_path: null,
      limitations: [expect.stringContaining("text is unavailable")],
    });
  });
});

describe("generic package entry heuristics", () => {
  it.each([
    ['{"main":"actual.cjs","module":"bundler.mjs"}', "actual.cjs"],
    ['{"module":"bundler.mjs"}', "bundler.mjs"],
  ])(
    "preserves generic entry heuristics without a module kind for %s",
    (metadata, entry) => {
      const files = fileMap([
        file("app/consumer.js", "root"),
        file("app/node_modules/fixture/package.json", "root", metadata),
        file("app/node_modules/fixture/actual.cjs", "root"),
        file("app/node_modules/fixture/bundler.mjs", "root"),
        file("app/node_modules/fixture/index.js", "root"),
      ]);
      expect(
        resolve({
          declaredPath: "fixture",
          sourcePath: "app/consumer.js",
          context: "module-specifier",
          files,
        }),
      ).toMatchObject({
        resolution_status: "resolved",
        resolved_path: `app/node_modules/fixture/${entry}`,
      });
    },
  );
});

describe("package exports exact targets", () => {
  it.each([
    ["./file", "app/node_modules/fixture/file.js"],
    ["./folder", "app/node_modules/fixture/folder/index.js"],
  ])(
    "resolves exports target %s only to that exact file",
    (target, nearMiss) => {
      const files = fileMap([
        file("app/consumer.js", "root"),
        file(
          "app/node_modules/fixture/package.json",
          "root",
          JSON.stringify({ exports: target }),
        ),
        file(nearMiss, "root"),
      ]);
      for (const moduleKind of ["import", "require"] as const) {
        const resolution = resolve({
          declaredPath: "fixture",
          sourcePath: "app/consumer.js",
          context: "module-specifier",
          moduleKind,
          files,
        });
        expect(resolution).toMatchObject({
          resolution_status: "not-found",
          resolved_path: null,
        });
        expect(resolution.limitations.join(" ")).toContain(
          "exports targets are exact files",
        );
      }
    },
  );

  it("keeps extension and index fallbacks for a legacy main entry", () => {
    for (const [main, target] of [
      ["./file", "app/node_modules/fixture/file.js"],
      ["./folder", "app/node_modules/fixture/folder/index.js"],
    ] as const) {
      const files = fileMap([
        file("app/consumer.js", "root"),
        file(
          "app/node_modules/fixture/package.json",
          "root",
          JSON.stringify({ main }),
        ),
        file(target, "root"),
      ]);
      expect(
        resolve({
          declaredPath: "fixture",
          sourcePath: "app/consumer.js",
          context: "module-specifier",
          moduleKind: "require",
          files,
        }),
      ).toMatchObject({ resolution_status: "resolved", resolved_path: target });
    }
  });
});

describe("package import alias resolution", () => {
  it.each(["import", "require"] as const)(
    "resolves an exact #%s alias from the enclosing package imports map",
    (moduleKind) => {
      const files = aliasFiles({
        "package.json": JSON.stringify({
          imports: { "#config": "./config.cjs" },
        }),
        "main.js": "",
        "config.cjs": "",
      });
      expect(
        resolve({
          declaredPath: "#config",
          sourcePath: "main.js",
          context: "module-specifier",
          moduleKind,
          files,
        }),
      ).toMatchObject({
        resolution_status: "resolved",
        resolved_path: "config.cjs",
        declared_path: "#config",
      });
    },
  );

  it("resolves an alias from a nested file through the enclosing package root", () => {
    const files = aliasFiles({
      "package.json": JSON.stringify({
        imports: { "#config": "./config.cjs" },
      }),
      "src/main.js": "",
      "config.cjs": "",
    });
    expect(
      resolve({
        declaredPath: "#config",
        sourcePath: "src/main.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "config.cjs",
    });
  });

  it("uses a nested package imports map rather than the application root", () => {
    const files = aliasFiles({
      "package.json": JSON.stringify({
        imports: { "#config": "./root.cjs" },
      }),
      "root.cjs": "",
      "node_modules/fixture/package.json": JSON.stringify({
        imports: { "#config": "./local.cjs" },
      }),
      "node_modules/fixture/index.js": "",
      "node_modules/fixture/local.cjs": "",
    });
    expect(
      resolve({
        declaredPath: "#config",
        sourcePath: "node_modules/fixture/index.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "node_modules/fixture/local.cjs",
    });
  });

  it("does not inherit an ancestor imports map across a nested package.json", () => {
    const files = aliasFiles({
      "package.json": JSON.stringify({
        imports: { "#config": "./root.cjs" },
      }),
      "root.cjs": "",
      "node_modules/fixture/package.json": "{}",
      "node_modules/fixture/index.js": "",
    });
    const outcome = resolve({
      declaredPath: "#config",
      sourcePath: "node_modules/fixture/index.js",
      context: "module-specifier",
      moduleKind: "require",
      files,
    });
    expect(outcome).toMatchObject({
      resolution_status: "external",
      resolved_path: null,
    });
    expect(outcome.limitations.join(" ")).toContain(
      "node_modules/fixture/package.json",
    );
    expect(outcome.limitations.join(" ")).not.toContain("root.cjs");
  });

  it("does not apply a nested package map to the application root importer", () => {
    const files = aliasFiles({
      "package.json": JSON.stringify({
        imports: { "#config": "./root.cjs" },
      }),
      "main.js": "",
      "root.cjs": "",
      "node_modules/fixture/package.json": JSON.stringify({
        imports: { "#config": "./local.cjs" },
      }),
      "node_modules/fixture/local.cjs": "",
    });
    expect(
      resolve({
        declaredPath: "#config",
        sourcePath: "main.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "root.cjs",
    });
  });
});

describe("package import alias target selection", () => {
  it("selects import and require conditions from an imports target", () => {
    const files = aliasFiles({
      "package.json": JSON.stringify({
        imports: {
          "#config": {
            import: "./config.mjs",
            require: "./config.cjs",
            default: "./fallback.js",
          },
        },
      }),
      "main.js": "",
      "config.mjs": "",
      "config.cjs": "",
      "fallback.js": "",
    });
    expect(
      resolve({
        declaredPath: "#config",
        sourcePath: "main.js",
        context: "module-specifier",
        moduleKind: "import",
        files,
      }).resolved_path,
    ).toBe("config.mjs");
    expect(
      resolve({
        declaredPath: "#config",
        sourcePath: "main.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }).resolved_path,
    ).toBe("config.cjs");
  });

  it("resolves array import targets at their first string entry", () => {
    const files = aliasFiles({
      "package.json": JSON.stringify({
        imports: { "#config": [{ import: "./missing.mjs" }, "./config.cjs"] },
      }),
      "main.js": "",
      "config.cjs": "",
    });
    expect(
      resolve({
        declaredPath: "#config",
        sourcePath: "main.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "config.cjs",
    });
  });

  it("does not add an extension or index to a selected import target", () => {
    const files = aliasFiles({
      "package.json": JSON.stringify({
        imports: { "#config": "./config" },
      }),
      "main.js": "",
      "config.cjs": "",
      "config/index.js": "",
    });
    const outcome = resolve({
      declaredPath: "#config",
      sourcePath: "main.js",
      context: "module-specifier",
      moduleKind: "require",
      files,
    });
    expect(outcome).toMatchObject({
      resolution_status: "not-found",
      resolved_path: null,
    });
    expect(outcome.limitations.join(" ")).toContain(
      "import targets are exact files",
    );
  });
});

describe("package import alias refusals", () => {
  it("reports a missing exact alias without looking in another package", () => {
    const files = aliasFiles({
      "package.json": JSON.stringify({
        imports: { "#config": "./config.cjs" },
      }),
      "main.js": "",
      "config.cjs": "",
    });
    const outcome = resolve({
      declaredPath: "#other",
      sourcePath: "main.js",
      context: "module-specifier",
      moduleKind: "require",
      files,
    });
    expect(outcome).toMatchObject({
      resolution_status: "external",
      resolved_path: null,
    });
    expect(outcome.limitations.join(" ")).toContain("#other");
    expect(outcome.limitations.join(" ")).toContain("#config");
  });

  it("reports an explicit null import target as blocked", () => {
    const files = aliasFiles({
      "package.json": JSON.stringify({
        imports: { "#config": null },
      }),
      "main.js": "",
      "config.cjs": "",
    });
    const outcome = resolve({
      declaredPath: "#config",
      sourcePath: "main.js",
      context: "module-specifier",
      moduleKind: "require",
      files,
    });
    expect(outcome).toMatchObject({
      resolution_status: "external",
      resolved_path: null,
    });
    expect(outcome.limitations.join(" ")).toContain("explicit null");
  });

  it("leaves wildcard import aliases unresolved", () => {
    const files = aliasFiles({
      "package.json": JSON.stringify({
        imports: { "#internal/*": "./src/*.js" },
      }),
      "main.js": "",
      "src/util.js": "",
    });
    const outcome = resolve({
      declaredPath: "#internal/util",
      sourcePath: "main.js",
      context: "module-specifier",
      moduleKind: "import",
      files,
    });
    expect(outcome).toMatchObject({
      resolution_status: "external",
      resolved_path: null,
    });
    expect(outcome.limitations.join(" ")).toMatch(/wildcard/i);
  });

  it("leaves recursive and external-package import targets unresolved", () => {
    const files = aliasFiles({
      "package.json": JSON.stringify({
        imports: { "#loop": "#config", "#dep": "fixture" },
      }),
      "main.js": "",
      "node_modules/fixture/index.js": "",
    });
    const recursive = resolve({
      declaredPath: "#loop",
      sourcePath: "main.js",
      context: "module-specifier",
      moduleKind: "require",
      files,
    });
    const external = resolve({
      declaredPath: "#dep",
      sourcePath: "main.js",
      context: "module-specifier",
      moduleKind: "require",
      files,
    });
    expect(recursive).toMatchObject({
      resolution_status: "external",
      resolved_path: null,
    });
    expect(recursive.limitations.join(" ")).toMatch(/recursive/i);
    expect(external).toMatchObject({
      resolution_status: "external",
      resolved_path: null,
    });
    expect(external.limitations.join(" ")).toMatch(/external-package/i);
  });

  it("rejects reserved hash specifiers", () => {
    const files = aliasFiles({
      "package.json": JSON.stringify({
        imports: { "#config": "./config.cjs" },
      }),
      "main.js": "",
      "config.cjs": "",
    });
    expect(
      resolve({
        declaredPath: "#",
        sourcePath: "main.js",
        context: "module-specifier",
        moduleKind: "import",
        files,
      }),
    ).toMatchObject({ resolution_status: "rejected", resolved_path: null });
  });

  it("does not use a foreign-container enclosing package.json", () => {
    const files = fileMap([
      file(
        "package.json",
        "other",
        JSON.stringify({ imports: { "#config": "./config.cjs" } }),
      ),
      file("main.js", "root"),
      file("config.cjs", "root"),
    ]);
    const outcome = resolve({
      declaredPath: "#config",
      sourcePath: "main.js",
      context: "module-specifier",
      moduleKind: "require",
      files,
    });
    expect(outcome).toMatchObject({
      resolution_status: "external",
      resolved_path: null,
    });
    expect(outcome.limitations.join(" ")).toContain("package scopes");
  });
});

describe("directory package entrypoint precedence", () => {
  it.each([
    ["require", '{"main":"actual.cjs"}', "actual.cjs"],
    ["require", '{"exports":{"require":"./actual.cjs"}}', "actual.cjs"],
    ["import", '{"exports":{"import":"./actual.mjs"}}', "actual.mjs"],
  ] as const)(
    "prefers declared %s entrypoints over index files",
    (moduleKind, metadata, entry) => {
      const files = fileMap([
        file("app/consumer.js", "root"),
        file("app/node_modules/fixture/package.json", "root", metadata),
        file(`app/node_modules/fixture/${entry}`, "root"),
        file("app/node_modules/fixture/index.js", "root"),
      ]);
      expect(
        resolve({
          declaredPath: "fixture",
          sourcePath: "app/consumer.js",
          context: "module-specifier",
          moduleKind,
          files,
        }),
      ).toMatchObject({
        resolution_status: "resolved",
        resolved_path: `app/node_modules/fixture/${entry}`,
      });
    },
  );

  it.each(["{}", '{"main":"."}'])(
    "preserves index fallback for package metadata %s",
    (metadata) => {
      const files = fileMap([
        file("app/consumer.js", "root"),
        file("app/entry/package.json", "root", metadata),
        file("app/entry/index.js", "root"),
      ]);
      expect(
        resolve({
          declaredPath: "./entry",
          sourcePath: "app/consumer.js",
          context: "module-specifier",
          moduleKind: "require",
          files,
        }),
      ).toMatchObject({
        resolution_status: "resolved",
        resolved_path: "app/entry/index.js",
      });
    },
  );

  it.each([null, "{"])(
    "keeps unreadable or invalid metadata explicit even when an index exists",
    (metadata) => {
      const files = fileMap([
        file("app/consumer.js", "root"),
        file("app/entry/package.json", "root", metadata),
        file("app/entry/index.js", "root"),
      ]);
      expect(
        resolve({
          declaredPath: "./entry",
          sourcePath: "app/consumer.js",
          context: "module-specifier",
          moduleKind: "require",
          files,
        }),
      ).toMatchObject({
        resolution_status: "unavailable",
        resolved_path: null,
      });
    },
  );

  it("does not replace a missing exports target with an index", () => {
    const files = fileMap([
      file("app/consumer.js", "root"),
      file(
        "app/node_modules/fixture/package.json",
        "root",
        '{"exports":"./missing.js"}',
      ),
      file("app/node_modules/fixture/index.js", "root"),
    ]);
    expect(
      resolve({
        declaredPath: "fixture",
        sourcePath: "app/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "not-found",
      resolved_path: null,
    });
  });

  it("keeps direct files ahead of a relative directory package", () => {
    const files = fileMap([
      file("app/consumer.js", "root"),
      file("app/entry.js", "root"),
      file("app/entry/package.json", "root", '{"main":"actual.js"}'),
      file("app/entry/actual.js", "root"),
      file("app/entry/index.js", "root"),
    ]);
    expect(
      resolve({
        declaredPath: "./entry",
        sourcePath: "app/consumer.js",
        context: "module-specifier",
        moduleKind: "require",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "app/entry.js",
    });
  });

  it("retains cycle diagnostics for generic package-entrypoint inference", () => {
    const files = fileMap([
      file("app/package.json", "root"),
      file("app/a/package.json", "root", '{"main":"../b"}'),
      file("app/b/package.json", "root", '{"main":"../a"}'),
    ]);
    expect(
      resolve({
        declaredPath: "./a",
        sourcePath: "app/package.json",
        context: "package-entrypoint",
        files,
      }),
    ).toMatchObject({
      resolution_status: "unavailable",
      resolved_path: null,
      limitations: [expect.stringContaining("cycle")],
    });
  });
});

describe("contextual JavaScript module identity", () => {
  it("retains CommonJS and ESM file-base identity during inert extraction", () => {
    const analysis = analyzeJavaScriptStaticSource(
      `
        import { BrowserWindow } from "electron";
        new BrowserWindow({ webPreferences: {
          preload: path.resolve("ignored", __dirname, "preload.cjs")
        }});
        new BrowserWindow({ webPreferences: {
          preload: fileURLToPath(new URL("./preload.mjs", import.meta.url))
        }});
        new BrowserWindow({ webPreferences: {
          preload: path.join(path.dirname(__filename), "legacy-preload.js")
        }});
        new BrowserWindow({ webPreferences: {
          preload: path.posix.resolve("/ignored", dirname(fileURLToPath(import.meta.url)), "esm-preload.js")
        }});
        new BrowserWindow({ webPreferences: {
          preload: path.posix.resolve(__dirname, "/shared", "absolute-preload.js/")
        }});
        new BrowserWindow({ webPreferences: {
          preload: path.posix.resolve(\`/templates\`, "template-preload.js")
        }});
        new BrowserWindow({ webPreferences: {
          preload: new URL("./remote-base.js", location.href)
        }});
        window.loadURL("file:///renderer/index.html");
      `,
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
          path: "esm-preload.js",
          resolution_context: "filesystem-expression",
        }),
        expect.objectContaining({
          path: "/shared/absolute-preload.js",
          resolution_context: "filesystem-expression",
        }),
        expect.objectContaining({
          path: "/templates/template-preload.js",
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
        expect.objectContaining({
          preload_path: "esm-preload.js",
          preload_resolution_context: "filesystem-expression",
        }),
        expect.objectContaining({
          preload_path: "/shared/absolute-preload.js",
          preload_resolution_context: "filesystem-expression",
        }),
        expect.objectContaining({
          preload_path: "/templates/template-preload.js",
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

describe("TypeScript NodeNext emitted-extension resolution", () => {
  const container = "container";

  it.each([
    ["./dep.js", "src/dep.ts"],
    ["./ui/Button.js", "src/ui/Button.tsx"],
    ["./cfg.mjs", "src/cfg.mts"],
    ["./legacy.cjs", "src/legacy.cts"],
  ] as const)(
    "resolves %s to its TypeScript source counterpart",
    (specifier, target) => {
      const files = fileMap([
        file("src/main.ts", container),
        file(target, container, "export const value = 1;"),
      ]);
      expect(
        resolve({
          declaredPath: specifier,
          sourcePath: "src/main.ts",
          context: "module-specifier",
          moduleKind: "import",
          files,
        }),
      ).toMatchObject({ resolution_status: "resolved", resolved_path: target });
    },
  );

  it.each([
    ["./dep.js", "src/dep.d.ts"],
    ["./cfg.mjs", "src/cfg.d.mts"],
    ["./legacy.cjs", "src/legacy.d.cts"],
  ] as const)(
    "resolves %s to a declaration counterpart",
    (specifier, target) => {
      const files = fileMap([
        file("src/main.ts", container),
        file(target, container, "export const value = 1;"),
      ]);
      expect(
        resolve({
          declaredPath: specifier,
          sourcePath: "src/main.ts",
          context: "module-specifier",
          moduleKind: "import",
          files,
        }),
      ).toMatchObject({ resolution_status: "resolved", resolved_path: target });
    },
  );

  it("prefers a present runtime file and keeps the fallback off for JS callers", () => {
    const files = fileMap([
      file("src/main.ts", container),
      file("src/dep.js", container),
      file("src/dep.ts", container),
      file("src/js-main.js", container),
    ]);
    expect(
      resolve({
        declaredPath: "./dep.js",
        sourcePath: "src/main.ts",
        context: "module-specifier",
        moduleKind: "import",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "src/dep.js",
    });
    expect(
      resolve({
        declaredPath: "./dep.js",
        sourcePath: "src/js-main.js",
        context: "module-specifier",
        moduleKind: "import",
        files: fileMap([
          file("src/js-main.js", container),
          file("src/dep.ts", container),
        ]),
      }),
    ).toMatchObject({ resolution_status: "not-found", resolved_path: null });
  });

  it("does not apply the mapping to URL resources or package export targets", () => {
    const urlFiles = fileMap([
      file("src/main.ts", container),
      file("src/asset.ts", container),
    ]);
    expect(
      resolve({
        declaredPath: "asset.js",
        sourcePath: "src/main.ts",
        context: "url-reference",
        files: urlFiles,
      }),
    ).toMatchObject({ resolution_status: "not-found", resolved_path: null });

    const packageFiles = fileMap([
      file("src/main.ts", container),
      file(
        "src/node_modules/fixture/package.json",
        container,
        '{"exports":"./dep.js"}',
      ),
      file("src/node_modules/fixture/dep.ts", container),
    ]);
    expect(
      resolve({
        declaredPath: "fixture",
        sourcePath: "src/main.ts",
        context: "module-specifier",
        moduleKind: "import",
        files: packageFiles,
      }),
    ).toMatchObject({ resolution_status: "not-found", resolved_path: null });
  });

  it("does not substitute source counterparts for directory or index resolution", () => {
    const files = fileMap([
      file("src/main.ts", container),
      file("src/lib/index.ts", container),
    ]);
    expect(
      resolve({
        declaredPath: "./lib.js",
        sourcePath: "src/main.ts",
        context: "module-specifier",
        moduleKind: "import",
        files,
      }),
    ).toMatchObject({ resolution_status: "not-found", resolved_path: null });
  });

  it("resolves an emitted dotfile name within its own directory", () => {
    const files = fileMap([
      file("src/main.ts", container),
      file("src/.ts", container),
    ]);
    expect(
      resolve({
        declaredPath: "./.js",
        sourcePath: "src/main.ts",
        context: "module-specifier",
        moduleKind: "import",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "src/.ts",
    });
  });
});

describe("url-reference JavaScript artifact path resolution", () => {
  it.each([
    "app%00.js.map",
    "app%FF.js.map",
    "app%C0%AF.js.map",
    "app%2ejs.map",
    "nested%2fworker.js",
    "nested%5cworker.js",
    "../../outside.js.map",
  ])("rejects an inadmissible URL path: %s", (declaredPath) => {
    const resolution = resolve({
      declaredPath,
      sourcePath: "dist/app.js",
      context: "url-reference",
      files: fileMap([
        file("dist/app.js.map", "root"),
        file("dist/nested/worker.js", "root"),
      ]),
    });
    expect(resolution).toMatchObject({
      declared_path: declaredPath,
      resolution_context: "url-reference",
      resolution_status: "rejected",
      resolved_path: null,
    });
    expect(resolution.limitations.length).toBeGreaterThan(0);
  });

  it("resolves sibling paths and rejects external URL forms", () => {
    const files = fileMap([
      file("dist/app.js", "root"),
      file("dist/app.js.map", "root"),
      file("dist/worker.js", "root"),
    ]);

    expect(
      resolve({
        declaredPath: "app.js.map",
        sourcePath: "dist/app.js",
        context: "url-reference",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "dist/app.js.map",
    });
    expect(
      resolve({
        declaredPath: "app.js.map?v=1#section",
        sourcePath: "dist/app.js",
        context: "url-reference",
        files,
      }),
    ).toMatchObject({
      resolution_status: "resolved",
      resolved_path: "dist/app.js.map",
    });
    expect(
      resolve({
        declaredPath: "//cdn.example.com/app.js.map",
        sourcePath: "dist/app.js",
        context: "url-reference",
        files,
      }),
    ).toMatchObject({
      resolution_status: "external",
      resolved_path: null,
    });
    expect(
      resolve({
        declaredPath: "https://cdn.example.com/app.js.map",
        sourcePath: "dist/app.js",
        context: "url-reference",
        files,
      }),
    ).toMatchObject({
      resolution_status: "external",
      resolved_path: null,
    });
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
      ? { included: false, reason: "invalid-utf8" }
      : { included: true, value: text },
});

const aliasFiles = (
  entries: Readonly<Record<string, string | null>>,
): ReturnType<typeof fileMap> =>
  fileMap(
    Object.entries(entries).map(([path, text]) =>
      file(path, "root", text ?? ""),
    ),
  );

describe("exact HTML resource resolution", () => {
  it.each([
    ["extension", ["app.js"]],
    ["directory index", ["app/index.js"]],
    ["directory package", ["app/package.json", "app/entry.js"]],
  ] as const)("does not infer a file from %s fallback", (_name, paths) => {
    const files = fileMap([
      file("index.html", "root"),
      ...paths.map((path) =>
        file(
          path,
          "root",
          path.endsWith("package.json") ? '{"main":"entry.js"}' : "",
        ),
      ),
    ]);
    expect(
      resolve({
        declaredPath: "./app",
        sourcePath: "index.html",
        context: "html-reference",
        files,
      }),
    ).toMatchObject({ resolution_status: "not-found", resolved_path: null });
  });

  it("prefers an exact extensionless resource and retains URL suffix handling", () => {
    const files = fileMap([
      file("renderer/index.html", "root"),
      file("assets/app", "root"),
      file("assets/app.js", "root"),
      file("assets/app/index.js", "root"),
    ]);
    expect(
      resolve({
        declaredPath: "./app?cache=1#v2",
        sourcePath: "renderer/index.html",
        context: "html-reference",
        htmlBaseHref: "/assets/",
        files,
      }),
    ).toMatchObject({
      declared_path: "./app?cache=1#v2",
      resolution_status: "resolved",
      resolved_path: "assets/app",
    });
  });
});
