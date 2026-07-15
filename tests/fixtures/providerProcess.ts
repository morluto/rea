import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(
  new URL("./providerProcess.mjs", import.meta.url),
);

/** Spawn one deterministic process-lifecycle fixture with piped diagnostics. */
export const spawnProviderProcessFixture = (
  mode: "burst" | "exit" | "graceful" | "stubborn",
  value?: number,
): ChildProcess =>
  spawn(
    process.execPath,
    [fixturePath, mode, ...(value === undefined ? [] : [String(value)])],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

/** Wait until a long-lived fixture has installed its signal behavior. */
export const waitForProviderProcessReady = (
  child: ChildProcess,
  timeoutMs = 2_000,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const stdout = child.stdout;
    if (stdout === null) {
      reject(new Error("Provider process fixture stdout is unavailable"));
      return;
    }
    let output = "";
    const detach = (): void => {
      clearTimeout(timer);
      stdout.off("data", onData);
      child.off("exit", onExit);
    };
    const onData = (chunk: Buffer | string): void => {
      output += chunk.toString();
      if (output.includes("ready\n")) {
        detach();
        resolve();
      }
    };
    const onExit = (): void => {
      detach();
      reject(new Error("Provider process fixture exited before readiness"));
    };
    const timer = setTimeout(() => {
      detach();
      reject(new Error("Provider process fixture readiness timed out"));
    }, timeoutMs);
    stdout.on("data", onData);
    child.once("exit", onExit);
  });

/** Kill a fixture if necessary and wait for its process handle to settle. */
export const stopProviderProcessFixture = async (
  child: ChildProcess,
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  child.kill("SIGKILL");
  await exited;
};
