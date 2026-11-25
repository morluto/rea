import { access } from "node:fs/promises";
import { expect } from "vitest";

/** Check that each recorded POSIX process group and working directory is absent. */
export const expectProviderLaunchCleanup = async (
  launches: readonly {
    readonly pid: number | undefined;
    readonly cwd: string | undefined;
  }[],
): Promise<void> => {
  for (const launch of launches) {
    const pid = launch.pid;
    if (pid !== undefined)
      expect(() => process.kill(-pid, 0)).toThrowError(
        expect.objectContaining({ code: "ESRCH" }),
      );
    if (launch.cwd !== undefined)
      await expect(access(launch.cwd)).rejects.toMatchObject({
        code: "ENOENT",
      });
  }
};
