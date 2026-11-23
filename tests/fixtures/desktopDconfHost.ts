import { open, stat } from "node:fs/promises";

/** Probe the host prerequisite separately from the dconf reader under test. */
export const hasReadableProcDescriptor = async (): Promise<boolean> => {
  const handle = await open(new URL(import.meta.url), "r");
  try {
    await stat(`/proc/${process.pid}/fd/${handle.fd}`);
    return true;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
};
