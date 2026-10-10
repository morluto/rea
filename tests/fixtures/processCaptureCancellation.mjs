import { spawn } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [mode, root] = process.argv.slice(2);

const publishReadyMarker = async (marker) => {
  const destination = join(root, "ready.json");
  const temporary = join(root, "ready.json.tmp");
  await writeFile(temporary, JSON.stringify(marker));
  await rename(temporary, destination);
};

if (mode === "settlement") {
  const child = spawn(process.execPath, [process.argv[1], "workload", root], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  child.on("message", async (message) => {
    if (message !== "ready" || child.pid === undefined) return;
    await publishReadyMarker({
      rootPid: process.pid,
      childPid: child.pid,
      runId: process.env.REA_PROCESS_RUN_ID,
    });
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
    await publishReadyMarker({
      rootPid: process.pid,
      runId: process.env.REA_PROCESS_RUN_ID,
    });
    process.stdout.write("owned workload ready\n");
  }
}
