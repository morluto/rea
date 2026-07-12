import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

if (process.platform !== "linux")
  throw new Error("Linux real-Hopper verification must run on Linux");
const launcher = process.env.HOPPER_LAUNCHER_PATH ?? "/opt/hopper/bin/Hopper";
await access(launcher);
const linked = await execFileAsync("ldd", [launcher]);
if (`${linked.stdout}\n${linked.stderr}`.includes("not found"))
  throw new Error("Hopper has unresolved shared-library dependencies");
if (
  process.env.DISPLAY === undefined &&
  process.env.WAYLAND_DISPLAY === undefined
)
  throw new Error(
    "Linux real-Hopper verification requires DISPLAY or WAYLAND_DISPLAY",
  );
process.env.HOPPER_LAUNCHER_PATH = launcher;
await import("./verify-real-hopper.mjs");
