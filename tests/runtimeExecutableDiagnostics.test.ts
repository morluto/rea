import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { inspectRuntimeExecutables } from "../src/application/RuntimeExecutableDiagnostics.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("runtime executable diagnostics", () => {
  it("preserves lexical and canonical identities for duplicate healthy runtimes", async () => {
    const first = await temporaryRoot();
    const second = await temporaryRoot();
    await symlink(process.execPath, join(first, "node"));
    await symlink(process.execPath, join(second, "node"));

    const inventory = await inspectRuntimeExecutables({
      platform: process.platform,
      path: [first, second].join(delimiter),
      launcherNode: process.execPath,
    });
    const pathNodes = inventory.candidates.filter(
      ({ tool, path_index: pathIndex }) =>
        tool === "node" && pathIndex !== null,
    );

    expect(pathNodes).toHaveLength(2);
    expect(pathNodes.map(({ selection }) => selection)).toEqual([
      "path-primary",
      "path-shadowed",
    ]);
    expect(new Set(pathNodes.map(({ canonical_path: path }) => path))).toEqual(
      new Set([process.execPath]),
    );
    expect(pathNodes.every(({ healthy }) => healthy)).toBe(true);
  });

  it("distinguishes a healthy primary runtime from a broken shadowed candidate", async () => {
    const healthy = await temporaryRoot();
    const broken = await temporaryRoot();
    await symlink(process.execPath, join(healthy, "node"));
    await executable(
      join(broken, "node"),
      "#!/bin/sh\necho broken-runtime >&2\nexit 17\n",
    );

    const inventory = await inspectRuntimeExecutables({
      platform: process.platform,
      path: [healthy, broken].join(delimiter),
      launcherNode: process.execPath,
    });
    const pathNodes = inventory.candidates.filter(
      ({ tool, path_index: pathIndex }) =>
        tool === "node" && pathIndex !== null,
    );

    expect(pathNodes[0]).toMatchObject({
      healthy: true,
      selection: "path-primary",
    });
    expect(pathNodes[1]).toMatchObject({
      healthy: false,
      selection: "path-shadowed",
      failure: {
        code: "runtime_nonzero_exit",
        exit_code: 17,
        stderr: "broken-runtime",
      },
    });
  });

  it("classifies a macOS dynamic-loader failure and names the dependency", async () => {
    const root = await temporaryRoot();
    await executable(
      join(root, "node"),
      "#!/bin/sh\necho 'dyld: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.29.dylib' >&2\nexit 134\n",
    );

    const inventory = await inspectRuntimeExecutables({
      platform: "darwin",
      path: root,
      launcherNode: process.execPath,
    });
    const candidate = inventory.candidates.find(
      ({ tool, path_index: pathIndex }) => tool === "node" && pathIndex === 0,
    );

    expect(candidate).toMatchObject({
      healthy: false,
      failure: {
        code: "runtime_dynamic_library_missing",
        dependency: "/opt/homebrew/opt/simdjson/lib/libsimdjson.29.dylib",
      },
    });
  });

  it("probes env shebangs under the diagnosed PATH", async () => {
    const root = await temporaryRoot();
    await symlink(process.execPath, join(root, "node"));
    await executable(
      join(root, "npm"),
      "#!/usr/bin/env node\nconsole.log('npm-under-effective-path')\n",
    );

    const inventory = await inspectRuntimeExecutables({
      platform: process.platform,
      path: root,
      launcherNode: process.execPath,
    });
    const npm = inventory.candidates.find(({ tool }) => tool === "npm");

    expect(npm).toMatchObject({
      healthy: true,
      version: "npm-under-effective-path",
      selection: "path-primary",
    });
  });

  it("classifies a bounded probe timeout before its kill signal", async () => {
    const root = await temporaryRoot();
    await executable(join(root, "node"), "#!/bin/sh\nwhile :; do :; done\n");

    const inventory = await inspectRuntimeExecutables({
      platform: process.platform,
      path: root,
      launcherNode: process.execPath,
      timeoutMs: 20,
    });
    const candidate = inventory.candidates.find(
      ({ tool, path_index: pathIndex }) => tool === "node" && pathIndex === 0,
    );

    expect(candidate).toMatchObject({
      healthy: false,
      failure: { code: "runtime_timeout", signal: "SIGTERM" },
    });
  });
});

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "rea-runtime-diagnostics-"));
  roots.push(root);
  return root;
};

const executable = async (path: string, source: string): Promise<void> => {
  await writeFile(path, source);
  await chmod(path, 0o700);
};
