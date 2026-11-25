/** Model the lazily read procfs descriptor used by process ownership tests. */
export const openProcDescriptorFixture = async (
  path: unknown,
  readBytes: () => Promise<string | Buffer>,
) => {
  if (!String(path).startsWith("/proc/"))
    throw new Error(`Unexpected descriptor open: ${String(path)}`);
  let bytes: Buffer | undefined;
  return {
    fd: 42,
    close: async () => {},
    read: async (
      buffer: Buffer,
      offset: number,
      length: number,
      position: bigint,
    ) => {
      bytes ??= Buffer.from(await readBytes());
      const start = Number(position);
      const count = bytes.copy(buffer, offset, start, start + length);
      return { bytesRead: count, buffer };
    },
  };
};
