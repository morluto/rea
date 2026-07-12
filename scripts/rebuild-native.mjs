#!/usr/bin/env node

import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const child = spawn(npm, ["rebuild", "node-pty"], {
  stdio: "inherit",
  env: { ...process.env, npm_config_build_from_source: "true" },
});

child.once("error", (error) => {
  console.error(`Unable to rebuild node-pty: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal !== null) {
    console.error(`node-pty rebuild terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
