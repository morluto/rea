#!/usr/bin/env node

import { chmod, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(
    require.resolve("node-pty/package.json", {
      paths: [dirname(fileURLToPath(import.meta.url))],
    }),
  );
  const helperPath = join(
    packageRoot,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );

  try {
    const helper = await lstat(helperPath);
    if (!helper.isFile() || helper.isSymbolicLink()) {
      throw new Error("node-pty spawn helper is not a regular file");
    }
    await chmod(helperPath, helper.mode | 0o111);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // Source builds place their correctly-modeled helper under build/Release.
    } else {
      throw error;
    }
  }
}
