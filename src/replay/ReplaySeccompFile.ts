import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLinuxX64ReplaySeccomp } from "./LinuxSeccompPolicy.js";

/** Own a private seccomp file and descriptor until probe or execution cleanup. */
export const temporaryFilterHandle = async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-replay-filter-"));
  const path = join(directory, "seccomp.bpf");
  try {
    await writeFile(path, buildLinuxX64ReplaySeccomp(), { mode: 0o600 });
    const handle = await open(path, "r");
    return {
      path,
      handle,
      close: async () => {
        try {
          await handle.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (cause: unknown) {
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }
};
