import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  chmod,
  copyFile,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const command = process.env.REA_VERIFY_SERVER_COMMAND;
if (process.platform !== "linux" || process.getuid?.() !== 0)
  throw new Error("Linux setup verification requires a root Linux runner");
if (!command) throw new Error("REA_VERIFY_SERVER_COMMAND is required");
try {
  await access("/opt/hopper/bin/Hopper");
  throw new Error("Linux setup verification requires a clean runner");
} catch (error) {
  if (error instanceof Error && error.message.includes("clean runner"))
    throw error;
}

const runJson = async (args) => {
  const { stdout } = await execFileAsync(command, args, {
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
};

const plan = await runJson(["setup", "--json"]);
if (plan.status !== "needs_confirmation")
  throw new Error("setup did not produce a read-only confirmation plan");
await access("/opt/hopper/bin/Hopper").then(
  () => {
    throw new Error("setup plan mutated the clean runner");
  },
  () => undefined,
);

const installed = await runJson([
  "setup",
  "--yes",
  "--install-hopper",
  "--json",
]);
if (
  installed.status !== "ready" ||
  !installed.appliedActions.includes("installed_hopper")
)
  throw new Error(
    `approved setup did not become ready: ${JSON.stringify(installed)}`,
  );
const doctor = await runJson(["doctor", "--json"]);
if (doctor.healthy !== true)
  throw new Error(`doctor is unhealthy: ${JSON.stringify(doctor)}`);

await execFileAsync(command, ["analyze", "/usr/bin/true"], {
  env: process.env,
  timeout: 180_000,
  maxBuffer: 10 * 1024 * 1024,
});
process.env.HOPPER_TARGET_PATH = "/usr/bin/true";
process.env.HOPPER_SECOND_TARGET_PATH = "/usr/bin/false";
process.env.REA_VERIFY_SERVER_ARGS_JSON = '["mcp"]';
await import("./verify-real-hopper-linux.mjs");

const modifiedDirectory = await mkdtemp(join(tmpdir(), "rea-modified-hopper-"));
try {
  const modifiedHopper = join(modifiedDirectory, "Hopper");
  await copyFile("/opt/hopper/bin/Hopper", modifiedHopper);
  await appendFile(modifiedHopper, new Uint8Array([0]));
  await chmod(modifiedHopper, 0o700);
  try {
    await execFileAsync(command, ["analyze", "/usr/bin/true"], {
      env: { ...process.env, HOPPER_LAUNCHER_PATH: modifiedHopper },
      timeout: 30_000,
    });
    throw new Error("modified Hopper build was not rejected");
  } catch (error) {
    const output = `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
    if (!output.includes("unsupported_hopper_build"))
      throw new Error(
        "modified Hopper build did not return its stable failure code",
      );
  }
} finally {
  await rm(modifiedDirectory, { recursive: true, force: true });
}

const repeated = await runJson([
  "setup",
  "--yes",
  "--install-hopper",
  "--json",
]);
if (
  repeated.status !== "ready" ||
  repeated.appliedActions.includes("installed_hopper")
)
  throw new Error("a second setup was not idempotent");
const { stdout: processes } = await execFileAsync("ps", [
  "-ax",
  "-o",
  "command=",
]);
if (/\/opt\/hopper\/bin\/Hopper|\bXvfb\b|hopper-demo-x11\.py/u.test(processes))
  throw new Error("Linux setup verification leaked a Hopper demo session");

console.log(
  JSON.stringify({
    status: "verified",
    setup: true,
    cli: true,
    mcp: true,
    idempotent: true,
  }),
);
