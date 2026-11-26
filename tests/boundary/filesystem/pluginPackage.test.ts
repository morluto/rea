import { expect, it } from "vitest";

import {
  pluginPackageMetadata,
  pluginPlatformPackages,
} from "../../../scripts/lib/plugin-package.mjs";

const fixture = () => ({
  manifest: {
    name: "rea-agents",
    version: "6.8.0",
    dependencies: { runtime: "1.0.0" },
    devDependencies: { builder: "1.0.0" },
    overrides: { builder: { nested: "2.0.0" } },
    scripts: {
      prepare: "node scripts/prepare.mjs",
      prepack: "node scripts/prepack.mjs",
      start: "node scripts/rea.mjs mcp",
    },
  },
  lock: {
    name: "rea-agents",
    version: "6.8.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "rea-agents",
        version: "6.8.0",
        dependencies: { runtime: "1.0.0" },
        devDependencies: { builder: "1.0.0" },
      },
      "node_modules/runtime": { version: "1.0.0", integrity: "source digest" },
      "node_modules/builder": { version: "1.0.0", dev: true },
      "node_modules/builder/node_modules/nested": {
        version: "2.0.0",
        dev: true,
      },
      "node_modules/optional": {
        version: "1.0.0",
        devOptional: true,
        optional: true,
      },
    },
  },
});

it("preserves locked runtime facts and optional dependencies without mutating source metadata", () => {
  const source = fixture();
  const before = structuredClone(source);
  const packed = pluginPackageMetadata(source.manifest, source.lock);
  expect(source).toEqual(before);
  // @ts-expect-error The projected manifest declares no prepare script.
  expect(packed.packageJson.scripts?.prepare).toBeUndefined();
  // An installed package never runs prepare, so npm need not ask to allow it.
  expect(packed.packageJson).toEqual({
    name: "rea-agents",
    version: "6.8.0",
    dependencies: { runtime: "1.0.0" },
    scripts: {
      prepack: "node scripts/prepack.mjs",
      start: "node scripts/rea.mjs mcp",
    },
    bundleDependencies: ["runtime"],
  });
  expect(packed.shrinkwrap.packages).toEqual({
    "": {
      name: "rea-agents",
      version: "6.8.0",
      dependencies: { runtime: "1.0.0" },
    },
    "node_modules/runtime": source.lock.packages["node_modules/runtime"],
    "node_modules/optional": source.lock.packages["node_modules/optional"],
  });
});

it("refuses to discard a security override when the package is also used at runtime", () => {
  const { manifest, lock } = fixture();
  lock.packages["node_modules/builder"].dev = false;
  expect(() => pluginPackageMetadata(manifest, lock)).toThrow(
    "runtime or unresolved override: builder",
  );
});

it("fails when an override cannot be attributed to the locked development tree", () => {
  const { manifest, lock } = fixture();
  delete (lock.packages as Record<string, unknown>)["node_modules/builder"];
  expect(() => pluginPackageMetadata(manifest, lock)).toThrow(
    "runtime or unresolved override: builder",
  );
});

it("refuses a stale lock before producing a release artifact", () => {
  const { manifest, lock } = fixture();
  lock.packages[""].version = "6.7.0";
  expect(() => pluginPackageMetadata(manifest, lock)).toThrow(
    "matching v3 package lock",
  );
});

const platformLock = () => ({
  name: "rea-agents",
  version: "6.8.0",
  lockfileVersion: 3,
  packages: {
    "": { name: "rea-agents", version: "6.8.0" } as Record<string, unknown>,
    "node_modules/pty": {
      version: "1.0.0",
      optionalDependencies: { "pty-darwin-arm64": "1.0.0" },
    } as Record<string, unknown>,
    "node_modules/pty-darwin-arm64": {
      version: "1.0.0",
      integrity: "pty digest",
      os: ["darwin"],
      cpu: ["arm64"],
      optional: true,
    } as Record<string, unknown>,
    "node_modules/xz": {
      version: "2.0.0",
      optionalDependencies: {
        "xz-win32-x64": "2.0.0",
        "xz-linux-x64": "2.0.0",
        "xz-freebsd-x64": "2.0.0",
        "xz-wasm32": "2.0.0",
      },
    } as Record<string, unknown>,
    "node_modules/xz-win32-x64": {
      version: "2.0.0",
      integrity: "win digest",
      os: ["win32"],
      cpu: ["x64"],
      optional: true,
    } as Record<string, unknown>,
    // A development copy of another version is hoisted; the runtime one nests.
    "node_modules/xz/node_modules/xz-linux-x64": {
      version: "2.0.0",
      integrity: "linux digest",
      os: ["linux"],
      cpu: ["x64"],
      optional: true,
    } as Record<string, unknown>,
    "node_modules/xz-freebsd-x64": {
      version: "2.0.0",
      integrity: "bsd digest",
      os: ["freebsd"],
      cpu: ["x64"],
      optional: true,
    } as Record<string, unknown>,
    "node_modules/xz-wasm32": {
      version: "2.0.0",
      integrity: "wasm digest",
      cpu: ["wasm32"],
      optional: true,
    } as Record<string, unknown>,
  },
});

it("bundles supported-host binaries of every runtime native dependency, not only the PTY", () => {
  expect(pluginPlatformPackages(platformLock())).toEqual([
    {
      name: "pty-darwin-arm64",
      path: "node_modules/pty-darwin-arm64",
      version: "1.0.0",
      integrity: "pty digest",
    },
    {
      name: "xz-win32-x64",
      path: "node_modules/xz-win32-x64",
      version: "2.0.0",
      integrity: "win digest",
    },
    {
      name: "xz-linux-x64",
      path: "node_modules/xz/node_modules/xz-linux-x64",
      version: "2.0.0",
      integrity: "linux digest",
    },
  ]);
});

it("refuses a supported-host binary the lock cannot pin", () => {
  const lock = platformLock();
  delete lock.packages["node_modules/xz-win32-x64"].integrity;
  expect(() => pluginPlatformPackages(lock)).toThrow(
    "Plugin platform dependency is not locked: xz-win32-x64",
  );
  delete (lock.packages as Record<string, unknown>)[
    "node_modules/xz-win32-x64"
  ];
  expect(() => pluginPlatformPackages(lock)).toThrow(
    "Plugin platform dependency is not locked: xz-win32-x64",
  );
});

it("covers the locked XZ decoder for macOS and Windows plugin hosts", async () => {
  const { readFile } = await import("node:fs/promises");
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  const names = pluginPlatformPackages(
    pluginPackageMetadata(manifest, lock).shrinkwrap,
  ).map(({ name }) => name);
  expect(names).toEqual(
    expect.arrayContaining([
      "@lydell/node-pty-darwin-arm64",
      "@lydell/node-pty-win32-x64",
      "@napi-rs/lzma-darwin-arm64",
      "@napi-rs/lzma-darwin-x64",
      "@napi-rs/lzma-linux-x64-gnu",
      "@napi-rs/lzma-win32-arm64-msvc",
      "@napi-rs/lzma-win32-x64-msvc",
    ]),
  );
  expect(names).not.toContain("@napi-rs/lzma-wasm32-wasi");
});
