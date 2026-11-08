import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Wait for a fixture's PID bytes, not merely the creation of its file. */
export const waitForTestPidFile = async (
  path: string,
  timeoutMs: number,
): Promise<number> => {
  const deadline = performance.now() + timeoutMs;
  do {
    let text = "";
    try {
      text = await readFile(path, "utf8");
    } catch (cause) {
      if (
        !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      )
        throw cause;
    }
    const pid = Number(text);
    if (/^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(pid)) return pid;
    await delay(10);
  } while (performance.now() < deadline);
  throw new Error(`Test process did not publish a valid PID in ${path}`);
};
