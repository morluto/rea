import { open } from "node:fs/promises";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { withOwnedFileHandle } from "../filesystem/OwnedRegularFile.js";
import { readFileHandleChunks } from "../filesystem/readFileHandleChunks.js";
import {
  assertProcessOwnershipInspectionActive,
  ProcessOwnershipInspectionCancelled,
  rethrowProcessOwnershipInspectionFailure,
} from "./ProcessInspectionCancellation.js";

/** procfs extents are synthetic: read to EOF through an owned descriptor. */
export const readProcessInspectionFile = async (
  path: string,
  signal?: AbortSignal,
): Promise<string> => {
  assertProcessOwnershipInspectionActive(signal);
  const owner = new OwnedFileHandle(await open(path, "r"));
  try {
    return await withOwnedFileHandle(
      path,
      owner,
      signal === undefined ? {} : { signal },
      async (handle) => {
        const bytes: Buffer[] = [];
        for await (const chunk of readFileHandleChunks(handle, {
          signal,
          cancellationFailure: (reason) =>
            new ProcessOwnershipInspectionCancelled(reason),
        }))
          bytes.push(chunk as Buffer);
        return Buffer.concat(bytes).toString("utf8");
      },
    );
  } catch (cause: unknown) {
    rethrowProcessOwnershipInspectionFailure(cause);
    throw cause;
  }
};
