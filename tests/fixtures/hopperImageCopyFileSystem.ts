import { open } from "node:fs/promises";

/** Observe completed writes to a real prepared-image file. */
export const hopperImageCopyFileSystem = (
  destination: string,
  afterWrite: (bytes: number) => Promise<void>,
  openFile: typeof open = open,
) => ({
  open: (async (...args: Parameters<typeof open>) => {
    const handle = await openFile(...args);
    if (args[0] === destination) {
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = (async (
        ...writeArgs: Parameters<typeof writeFile>
      ) => {
        await writeFile(...writeArgs);
        const data = writeArgs[0];
        if (!Buffer.isBuffer(data)) throw new Error("Expected a buffer write");
        await afterWrite(data.length);
      }) as typeof handle.writeFile;
    }
    return handle;
  }) as typeof open,
});
