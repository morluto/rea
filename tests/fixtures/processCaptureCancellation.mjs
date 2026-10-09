import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const [mode, root] = process.argv.slice(2);

if (mode === "settlement") {
  const child = spawn(process.execPath, [process.argv[1], "workload", root], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.on("message", async (message) => {
    if (message !== "ready" || child.pid === undefined) return;
    await writeFile(
      join(root, "ready.json"),
      JSON.stringify({
        rootPid: process.pid,
        childPid: child.pid,
        runId: process.env.REA_PROCESS_RUN_ID,
      }),
    );
    child.disconnect();
    child.unref();
    process.stdout.write("root exiting; owned workload remains\n");
    process.exit(0);
  });
} else {
  // A closed PTY must not masquerade as capture cancellation in this fixture.
  process.on("SIGHUP", () => undefined);
  setTimeout(
    () => void writeFile(join(root, "late-write"), "still running"),
    6_000,
  );
  setTimeout(() => process.exit(0), 12_000);
  if (mode === "workload") process.send?.("ready");
  else {
    await writeFile(
      join(root, "ready.json"),
      JSON.stringify({
        rootPid: process.pid,
        runId: process.env.REA_PROCESS_RUN_ID,
      }),
    );
    process.stdout.write("owned workload ready\n");
  }
}
