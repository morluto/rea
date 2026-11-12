import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

// Fork an inherited-stdio descendant, publish both PIDs, then exit so the
// doctor sees stdin EOF and a dead launcher while the descendant keeps running.
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
  stdio: "inherit",
});
if (process.env.REA_MCP_DOCTOR_PID_PATH !== undefined)
  await writeFile(
    process.env.REA_MCP_DOCTOR_PID_PATH,
    JSON.stringify({ launcher: process.pid, descendant: descendant.pid }),
  );
process.exit(0);
