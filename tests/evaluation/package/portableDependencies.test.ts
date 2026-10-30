import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  portableDependencies,
  type PortableLockEntry,
} from "../../../scripts/lib/portable-dependencies.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const dependency = (fields: PortableLockEntry = {}): PortableLockEntry => ({
  version: "1.0.0",
  ...fields,
});

async function installed(...paths: string[]) {
  const root = await createTestTempDirectory("rea-portable-dependencies-");
  for (const path of paths) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, "package.json"), '{"version":"1.0.0"}');
  }
  return root;
}

it("allows a missing root optional provider overriding dependencies and its optional-only dependencies", async () => {
  const root = await installed("node_modules/required");
  const packages = {
    "": {
      dependencies: { required: "1", frida: "1" },
      optionalDependencies: { frida: "1" },
    },
    "node_modules/required": dependency(),
    "node_modules/frida": dependency({
      optional: true,
      dependencies: { bindings: "1" },
    }),
    "node_modules/bindings": dependency({ optional: true }),
  };
  await expect(
    portableDependencies(root, { packages }, "win32", "x64"),
  ).resolves.toEqual([{ path: "node_modules/required", version: "1.0.0" }]);
});

it("requires matching-host native dependencies of an enabled package", async () => {
  const root = await installed("node_modules/pty");
  const packages = {
    "": { dependencies: { pty: "1" } },
    "node_modules/pty": dependency({
      optionalDependencies: { "pty-win": "1", "pty-linux": "1" },
    }),
    "node_modules/pty-win": dependency({
      optional: true,
      os: ["win32"],
      cpu: ["x64"],
    }),
    "node_modules/pty-linux": dependency({
      optional: true,
      os: ["linux"],
      cpu: ["x64"],
    }),
  };
  await expect(
    portableDependencies(root, { packages }, "win32", "x64"),
  ).rejects.toThrow("Installed dependency is missing: node_modules/pty-win");
  await mkdir(join(root, "node_modules/pty-win"));
  await writeFile(
    join(root, "node_modules/pty-win/package.json"),
    '{"version":"1.0.0"}',
  );
  await expect(
    portableDependencies(root, { packages }, "win32", "x64"),
  ).resolves.toHaveLength(2);
});

it("requires transitive dependencies when the root optional provider is installed", async () => {
  const root = await installed("node_modules/frida");
  const packages = {
    "": { optionalDependencies: { frida: "1" } },
    "node_modules/frida": dependency({
      optional: true,
      dependencies: { bindings: "1" },
    }),
    "node_modules/bindings": dependency({ optional: true }),
  };
  await expect(
    portableDependencies(root, { packages }, "win32", "x64"),
  ).rejects.toThrow("Installed dependency is missing: node_modules/bindings");
});

it("keeps a shared dependency required even when the optional provider is absent", async () => {
  const root = await installed("node_modules/required");
  const packages = {
    "": {
      dependencies: { required: "1" },
      optionalDependencies: { frida: "1" },
    },
    "node_modules/required": dependency({ dependencies: { shared: "1" } }),
    "node_modules/frida": dependency({
      optional: true,
      dependencies: { shared: "1" },
    }),
    "node_modules/shared": dependency(),
  };
  await expect(
    portableDependencies(root, { packages }, "win32", "x64"),
  ).rejects.toThrow("Installed dependency is missing: node_modules/shared");
});

it("resolves nested dependencies before a hoisted optional-provider dependency", async () => {
  const paths = [
    "node_modules/required",
    "node_modules/required/node_modules/shared",
  ];
  const root = await installed(...paths);
  const packages = {
    "": {
      dependencies: { required: "1" },
      optionalDependencies: { frida: "1" },
    },
    "node_modules/required": dependency({ dependencies: { shared: "1" } }),
    "node_modules/required/node_modules/shared": dependency(),
    "node_modules/frida": dependency({
      optional: true,
      dependencies: { shared: "1" },
    }),
    "node_modules/shared": dependency({ optional: true }),
  };
  await expect(
    portableDependencies(root, { packages }, "win32", "x64"),
  ).resolves.toEqual(paths.map((path) => ({ path, version: "1.0.0" })));
});

it.each([
  { os: ["!darwin"], cpu: ["!arm64"], applies: true },
  { os: ["!win32"], cpu: ["x64"], applies: false },
  { os: ["win32"], cpu: ["!x64"], applies: false },
  { os: ["win32", "!win32"], applies: false },
  { os: ["win32", "!linux"], applies: true },
  { os: ["linux", "!darwin"], applies: false },
  { cpu: ["x64", "!x64"], applies: false },
  { cpu: ["x64", "!arm64"], applies: true },
  { cpu: ["arm64", "!ia32"], applies: false },
  { os: ["any"], cpu: ["any"], applies: true },
  { os: [], cpu: [], applies: true },
  { os: "!darwin", cpu: "x64", applies: true },
  { os: "!win32", applies: false },
  { os: ["any", "linux"], applies: false },
  { libc: ["glibc"], applies: false },
  { libc: "musl", applies: false },
  { libc: ["!musl"], applies: false },
  { libc: ["any"], applies: false },
  { libc: [], applies: false },
  { libc: "", applies: true },
])(
  "checks missing native packages using npm selectors: %j",
  async ({ applies, ...selectors }) => {
    const root = await installed("node_modules/required");
    const packages = {
      "": { dependencies: { required: "1" } },
      "node_modules/required": dependency({
        optionalDependencies: { native: "1" },
      }),
      "node_modules/native": dependency({ optional: true, ...selectors }),
    };
    const result = portableDependencies(root, { packages }, "win32", "x64");
    if (applies)
      await expect(result).rejects.toThrow(
        "Installed dependency is missing: node_modules/native",
      );
    else
      await expect(result).resolves.toEqual([
        { path: "node_modules/required", version: "1.0.0" },
      ]);
  },
);
