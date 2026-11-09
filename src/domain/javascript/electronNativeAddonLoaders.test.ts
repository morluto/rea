import { describe, expect, it } from "vitest";

import { analyzeCommonJsStaticFixture } from "../../../tests/fixtures/javascriptCommonJsAnalysis.js";
import { estimateJavaScriptStaticApplicationProjection } from "./javascriptApplicationProjectionResources.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";

describe("native addon helper package static recovery", () => {
  it("recovers node-gyp-build bindings across CommonJS, ESM, and lazy getters", () => {
    const cjs = analyzeCommonJsStaticFixture(`
      const path = require("node:path");
      const load = require("node-gyp-build");
      const { open, close } = load(__dirname);
      module.exports = require("node-gyp-build")(path.join(__dirname, ".."));
      let cached;
      function lazy() {
        return (cached ??= load(__dirname.replace("app.asar", "app.asar.unpacked")));
      }
    `);
    expect(cjs.electron.native_addon_bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specifier: "node-gyp-build:.",
          binding_kind: "require",
          members: ["close", "open"],
          resolution: { kind: "node-gyp-build", directory: "." },
        }),
        expect.objectContaining({
          specifier: "node-gyp-build:..",
          binding_kind: "re-export",
          namespace_access: true,
          resolution: { kind: "node-gyp-build", directory: ".." },
        }),
        expect.objectContaining({
          specifier: "node-gyp-build:.",
          binding_kind: "require",
          resolution: {
            kind: "node-gyp-build",
            directory: ".",
            asar_unpacked: true,
          },
        }),
      ]),
    );

    const esm = analyzeJavaScriptStaticSource(`
      import nodeGypBuild from "node-gyp-build";
      export const native = nodeGypBuild(import.meta.dirname);
      const fallback = () => nodeGypBuild();
    `);
    expect(esm.electron.native_addon_bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specifier: "node-gyp-build:.",
          binding_kind: "require",
          resolution: { kind: "node-gyp-build", directory: "." },
        }),
        expect.objectContaining({
          specifier: "node-gyp-build",
          binding_kind: "require",
          resolution: { kind: "node-gyp-build", directory: null },
        }),
      ]),
    );
  });

  it("recovers bindings helper calls and rejects escaped option objects", () => {
    const cjs = analyzeCommonJsStaticFixture(`
      const bindings = require("bindings");
      const { encrypt } = bindings("keychain");
      const safeOpts = {
        bindings: "sqlite.node",
        module_root: __dirname.replace("app.asar", "app.asar.unpacked"),
      };
      module.exports = require("bindings")(safeOpts);
    `);
    expect(cjs.electron.native_addon_bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specifier: "keychain.node",
          binding_kind: "require",
          members: ["encrypt"],
          resolution: {
            kind: "bindings",
            addon_name: "keychain.node",
            module_root: null,
          },
        }),
        expect.objectContaining({
          specifier: "sqlite.node",
          binding_kind: "re-export",
          resolution: {
            kind: "bindings",
            addon_name: "sqlite.node",
            module_root: ".",
            asar_unpacked: true,
          },
        }),
      ]),
    );

    const escaped = analyzeCommonJsStaticFixture(`
      const bindings = require("bindings");
      const opts = { bindings: "first", module_root: __dirname };
      globalThis.externalConfigure(opts);
      const addon = bindings(opts);
    `);
    expect(escaped.electron.native_addon_bindings).toEqual([]);
    expect(escaped.parse_status).toBe("partial");
    expect(
      escaped.analysis_coverage?.semantics.unknown_findings,
    ).toBeGreaterThan(0);
  });
});

describe("native addon dlopen and host-axis template recovery", () => {
  it("recovers process.dlopen calls and distinguishes module re-export from custom holders", () => {
    const cjs = analyzeCommonJsStaticFixture(`
      const path = require("node:path");
      process.dlopen(module, path.join(__dirname, "native", "bridge.node"));
      const holder = { exports: {} };
      process.dlopen(holder, require.resolve("./local.node"));
      process.dlopen(holder, "/opt/unanchored/external.node");
    `);
    expect(cjs.electron.native_addon_bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specifier: "native/bridge.node",
          binding_kind: "re-export",
          resolution: {
            kind: "candidates",
            resolution_context: "filesystem-expression",
            candidates: ["native/bridge.node"],
          },
        }),
        expect.objectContaining({
          specifier: "./local.node",
          binding_kind: "require",
          resolution: {
            kind: "candidates",
            resolution_context: "module-specifier",
            candidates: ["./local.node"],
          },
        }),
        expect.objectContaining({
          specifier: "/opt/unanchored/external.node",
          binding_kind: "require",
          resolution: {
            kind: "candidates",
            resolution_context: "filesystem-expression",
            candidates: [],
          },
        }),
      ]),
    );
  });

  it("expands bounded platform and arch .node templates across require and createRequire", () => {
    const cjs = analyzeCommonJsStaticFixture(`
      const os = require("os");
      const path = require("path");
      const { platform, arch } = process;
      const a = require(\`./build/\${os.platform()}/libfoo-\${os.arch()}.node\`);
      let b = null;
      b = require(path.join(__dirname, "prebuilds", \`\${platform}-\${arch}\`, "addon.node"));
    `);
    expect(cjs.electron.native_addon_bindings).toHaveLength(2);
    const specifierTemplate = cjs.electron.native_addon_bindings.find(
      ({ specifier }) =>
        specifier === "./build/${platform}/libfoo-${arch}.node",
    );
    expect(specifierTemplate?.resolution).toMatchObject({
      kind: "candidates",
      resolution_context: "module-specifier",
    });
    if (specifierTemplate?.resolution?.kind === "candidates") {
      expect(specifierTemplate.resolution.candidates).toHaveLength(9);
      expect(specifierTemplate.resolution.candidates).toContain(
        "./build/darwin/libfoo-arm64.node",
      );
      expect(specifierTemplate.resolution.candidates).toContain(
        "./build/win32/libfoo-x64.node",
      );
    }

    const fsTemplate = cjs.electron.native_addon_bindings.find(
      ({ specifier }) =>
        specifier === "prebuilds/${platform}-${arch}/addon.node",
    );
    expect(fsTemplate?.resolution).toMatchObject({
      kind: "candidates",
      resolution_context: "filesystem-expression",
    });

    const esm = analyzeJavaScriptStaticSource(`
      import { createRequire } from "node:module";
      const req = createRequire(import.meta.url);
      const addon = req("./native-" + process.platform + ".node");
    `);
    expect(esm.electron.native_addon_bindings).toEqual([
      expect.objectContaining({
        specifier: "./native-${platform}.node",
        resolution: {
          kind: "candidates",
          resolution_context: "module-specifier",
          candidates: [
            "./native-darwin.node",
            "./native-linux.node",
            "./native-win32.node",
          ],
        },
      }),
    ]);
  });

  it("rejects local functions, reassigned bindings, shadowed globals, and arbitrary dynamic paths", () => {
    const cjs = analyzeCommonJsStaticFixture(`
      function load(dir) { return dir; }
      function bindings(name) { return name; }
      const fake = { dlopen(m, p) { return [m, p]; } };
      const x = load(__dirname);
      const y = bindings("not_native");
      fake.dlopen(module, path?.join?.(__dirname, "fake.node"));

      let mutatedLoad = require("node-gyp-build");
      mutatedLoad = load;
      const z = mutatedLoad(__dirname);

      function shadowed(process, os) {
        return require(\`./\${process.platform}-\${os.arch()}.node\`);
      }
      const env = globalThis.CUSTOM_SUFFIX;
      const dyn = require(\`./native-\${env}.node\`);
    `);
    expect(cjs.electron.native_addon_bindings).toEqual([]);
    expect(cjs.parse_status).toBe("partial");
    expect(cjs.analysis_coverage?.semantics.unknown_findings).toBeGreaterThan(
      0,
    );

    const mutatedMeta = analyzeJavaScriptStaticSource(`
      import nodeGypBuild from "node-gyp-build";
      import.meta.dirname = "/tampered";
      export const addon = nodeGypBuild(import.meta.dirname);
    `);
    expect(mutatedMeta.electron.native_addon_bindings).toEqual([]);
  });
});

describe("native addon path proofs, mutation guards, and projection budgets", () => {
  it("preserves anchored directory offsets and decodes URL-expanded candidates", () => {
    const cjs = analyzeCommonJsStaticFixture(`
      const path = require("node:path");
      const a = require(\`\${path.join(__dirname, "native")}/bridge-\${process.arch}.node\`);
      const b = require(path.join(__dirname, "native") + "/addon.node");
    `);
    expect(cjs.electron.native_addon_bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specifier: "native/bridge-${arch}.node",
          resolution: {
            kind: "candidates",
            resolution_context: "filesystem-expression",
            candidates: [
              "native/bridge-arm64.node",
              "native/bridge-ia32.node",
              "native/bridge-x64.node",
            ],
          },
        }),
        expect.objectContaining({
          specifier: "native/addon.node",
          resolution: {
            kind: "candidates",
            resolution_context: "filesystem-expression",
            candidates: ["native/addon.node"],
          },
        }),
      ]),
    );

    const esm = analyzeJavaScriptStaticSource(`
      import { createRequire } from "node:module";
      import { fileURLToPath } from "node:url";
      const req = createRequire(import.meta.url);
      export const addon = req(
        fileURLToPath(
          new URL(\`./native%20dir/\${process.platform}/space%20addon.node?cache=1#v2\`, import.meta.url),
        ),
      );
    `);
    expect(esm.electron.native_addon_bindings).toEqual([
      expect.objectContaining({
        specifier: "./native dir/${platform}/space addon.node",
        resolution: {
          kind: "candidates",
          resolution_context: "filesystem-expression",
          candidates: [
            "./native dir/darwin/space addon.node",
            "./native dir/linux/space addon.node",
            "./native dir/win32/space addon.node",
          ],
        },
      }),
    ]);
  });

  it("rejects patched node:process imports, mutated require.resolve, and unresolved path.join literals", () => {
    const patchedProcess = analyzeJavaScriptStaticSource(`
      import { createRequire } from "node:module";
      import p from "node:process";
      import q from "node:process";
      Object.defineProperty(q, "arch", { value: "custom" });
      const req = createRequire(import.meta.url);
      export const addon = req(\`./\${p.arch}.node\`);
    `);
    expect(patchedProcess.electron.native_addon_bindings).toEqual([]);
    expect(patchedProcess.parse_status).toBe("partial");
    expect(
      patchedProcess.analysis_coverage?.semantics.unknown_findings,
    ).toBeGreaterThan(0);

    const replacedResolve = analyzeCommonJsStaticFixture(`
      require.resolve = () => "/other.node";
      process.dlopen(module, require.resolve("./addon.node"));
    `);
    expect(replacedResolve.electron.native_addon_bindings).toEqual([]);
    expect(replacedResolve.parse_status).toBe("partial");
    expect(
      replacedResolve.analysis_coverage?.semantics.unknown_findings,
    ).toBeGreaterThan(0);

    const unresolvedJoin = analyzeCommonJsStaticFixture(`
      const path = require("node:path");
      const addon = require(path.join(__dirname, globalThis.variant, "addon.node"));
    `);
    expect(unresolvedJoin.electron.native_addon_bindings).toEqual([]);
    expect(unresolvedJoin.parse_status).toBe("partial");
    expect(
      unresolvedJoin.analysis_coverage?.semantics.unknown_findings,
    ).toBeGreaterThan(0);
  });

  it("scales projection estimates with resolved native addon target counts", () => {
    const facts = analyzeCommonJsStaticFixture(`
      const load = require("node-gyp-build");
      const first = load(__dirname);
      const second = load(__dirname);
    `);
    const fallbackEstimate = estimateJavaScriptStaticApplicationProjection(
      facts,
      256,
      "node_modules/pkg/index.cjs",
    );
    const expandedEstimate = estimateJavaScriptStaticApplicationProjection(
      facts,
      256,
      "node_modules/pkg/index.cjs",
      () => 12,
    );
    expect(expandedEstimate).toBeGreaterThan(fallbackEstimate);
  });
});

it("rejects global process loaders/axes after node:process alias patches and handles require.resolve search paths", () => {
  const patchedGlobalDlopen = analyzeJavaScriptStaticSource(`
    import p from "node:process";
    p.dlopen = () => {};
    const holder = { exports: {} };
    process.dlopen(holder, "/tmp/addon.node");
    globalThis.process.dlopen(holder, "/tmp/addon.node");
  `);
  expect(patchedGlobalDlopen.electron.native_addon_bindings).toEqual([]);

  const escapedProcessDlopen = analyzeJavaScriptStaticSource(`
    import p from "node:process";
    mutate(p);
    const holder = { exports: {} };
    process.dlopen(holder, "/tmp/addon.node");
  `);
  expect(escapedProcessDlopen.electron.native_addon_bindings).toEqual([]);

  const patchedGlobalAxis = analyzeJavaScriptStaticSource(`
    import { createRequire } from "node:module";
    import p from "node:process";
    p.platform = "custom";
    const req = createRequire(import.meta.url);
    export const a = req(\`./\${process.platform}/addon.node\`);
    export const b = req(\`./\${globalThis.process.platform}/addon.node\`);
  `);
  expect(patchedGlobalAxis.electron.native_addon_bindings).toEqual([]);
  expect(
    patchedGlobalAxis.analysis_coverage?.semantics.unknown_findings,
  ).toBeGreaterThan(0);

  const rebasedResolve = analyzeCommonJsStaticFixture(`
    const path = require("node:path");
    process.dlopen(
      module,
      require.resolve("./addon.node", { paths: [path.join(__dirname, "native")] }),
    );
  `);
  expect(rebasedResolve.electron.native_addon_bindings).toMatchObject([
    {
      specifier: "./addon.node",
      resolution: {
        kind: "candidates",
        resolution_context: "filesystem-expression",
        candidates: ["native/addon.node"],
      },
    },
  ]);

  const unknownResolveOptions = analyzeCommonJsStaticFixture(`
    process.dlopen(
      module,
      require.resolve("./addon.node", { paths: [globalThis.customSearch] }),
    );
  `);
  expect(unknownResolveOptions.electron.native_addon_bindings).toEqual([]);
  expect(
    unknownResolveOptions.analysis_coverage?.semantics.unknown_findings,
  ).toBeGreaterThan(0);
});
