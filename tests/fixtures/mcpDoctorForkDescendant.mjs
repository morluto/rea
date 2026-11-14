import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

// Start an inherited-stdio descendant, publish both PIDs, then exit so the
// doctor sees a dead launcher while the descendant keeps its output open. A
// detached descendant leads its own session, outside the launcher's group. It
// exits by itself after 30 seconds so a failed cleanup cannot leak it forever.
const descendant = spawn(
  process.execPath,
  [
    "-e",
    "setInterval(() => {}, 1_000); setTimeout(() => process.exit(0), 30_000);",
  ],
  {
    detached: process.env.REA_MCP_DOCTOR_DESCENDANT_DETACHED === "1",
    stdio: "inherit",
  },
);
if (process.env.REA_MCP_DOCTOR_PID_PATH !== undefined)
  await writeFile(
    process.env.REA_MCP_DOCTOR_PID_PATH,
    JSON.stringify({ launcher: process.pid, descendant: descendant.pid }),
  );
process.exit(0);
