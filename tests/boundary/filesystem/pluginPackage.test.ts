import { expect, it } from "vitest";

import { pluginPackageMetadata } from "../../../scripts/lib/plugin-package.mjs";

const fixture = () => ({
  manifest: {
    name: "rea-agents",
    version: "6.8.0",
    dependencies: { runtime: "1.0.0" },
    devDependencies: { builder: "1.0.0" },
    overrides: { builder: { nested: "2.0.0" } },
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
  expect(packed.packageJson).toEqual({
    name: "rea-agents",
    version: "6.8.0",
    dependencies: { runtime: "1.0.0" },
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

type MutableManifest = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
};

type MutableLock = {
  name: string;
  version: string;
  lockfileVersion: number;
  packages: Record<string, { version?: string; dependencies?: unknown }>;
};

const mutableFixture = () =>
  fixture() as unknown as { manifest: MutableManifest; lock: MutableLock };

it("pins an exact runtime override into the published shrinkwrap", () => {
  const { manifest, lock } = mutableFixture();
  manifest.overrides = { shared: "2.0.0" };
  lock.packages["node_modules/runtime"]!.dependencies = { shared: "^1.0.0" };
  lock.packages["node_modules/shared"] = { version: "2.0.0" };
  const before = structuredClone(lock);
  const packed = pluginPackageMetadata(manifest, lock);
  expect(
    (
      packed.shrinkwrap.packages["node_modules/runtime"]!
        .dependencies as Record<string, string>
    ).shared,
  ).toBe("2.0.0");
  expect(packed.shrinkwrap.packages["node_modules/shared"]!.version).toBe(
    "2.0.0",
  );
  expect(lock).toEqual(before);
});

it("refuses a runtime override that does not match the locked version", () => {
  const { manifest, lock } = mutableFixture();
  manifest.overrides = { shared: "2.0.0" };
  lock.packages["node_modules/runtime"]!.dependencies = { shared: "^1.0.0" };
  lock.packages["node_modules/shared"] = { version: "1.0.0" };
  expect(() => pluginPackageMetadata(manifest, lock)).toThrow(
    "runtime or unresolved override: shared",
  );
});

it("refuses a non-exact runtime override", () => {
  const { manifest, lock } = mutableFixture();
  manifest.overrides = { shared: "^2.0.0" };
  lock.packages["node_modules/runtime"]!.dependencies = { shared: "^1.0.0" };
  lock.packages["node_modules/shared"] = { version: "2.0.0" };
  expect(() => pluginPackageMetadata(manifest, lock)).toThrow(
    "runtime or unresolved override: shared",
  );
});

it("refuses an override for a published direct dependency", () => {
  const { manifest, lock } = mutableFixture();
  manifest.dependencies = {
    ...manifest.dependencies,
    shared: "2.0.0",
  };
  manifest.overrides = { shared: "2.0.0" };
  lock.packages["node_modules/shared"] = { version: "2.0.0" };
  expect(() => pluginPackageMetadata(manifest, lock)).toThrow(
    "runtime or unresolved override: shared",
  );
});
