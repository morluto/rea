import type { ChildProcess } from "node:child_process";
import { err, ok, type Result } from "../domain/result.js";

/** An owned child or one of its pipes could not be detached from the event loop. */
export class OwnedProcessDetachError extends Error {
  readonly _tag = "OwnedProcessDetachError";
}

/** Keep a directly owned child usable while preventing its handles from pinning this process. */
export const detachOwnedProcessHandles = (
  child: ChildProcess,
): Result<null, OwnedProcessDetachError> => {
  try {
    for (const stream of [child.stdin, child.stdout, child.stderr])
      if (stream !== null && stream !== undefined && "unref" in stream)
        (stream as { unref: () => void }).unref();
    child.unref();
    return ok(null);
  } catch (cause: unknown) {
    return err(
      new OwnedProcessDetachError("Could not detach owned process handles.", {
        cause,
      }),
    );
  }
};
