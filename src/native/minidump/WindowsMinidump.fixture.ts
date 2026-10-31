/** Hand-authored AMD64 minidump bytes, independent of the production decoder. */
export interface WindowsMinidumpFixture {
  readonly bytes: Buffer;
  /** RVA of each stream body keyed by stream type. */
  readonly streams: ReadonlyMap<number, { offset: number; bytes: number }>;
  readonly directoryRva: number;
  readonly stackRva: number;
  readonly memory64Rva: number;
}

const align = (value: number) => (value + 7) & ~7;

export const windowsMinidumpFixture = (
  options: { readonly architecture?: number } = {},
): WindowsMinidumpFixture => {
  const parts: Buffer[] = [];
  let end = 0;
  const place = (body: Buffer): number => {
    const offset = align(end);
    if (offset > end) parts.push(Buffer.alloc(offset - end));
    parts.push(body);
    end = offset + body.length;
    return offset;
  };
  place(Buffer.alloc(32)); // header, written last
  const streamTypes = [7, 3, 4, 5, 6, 9, 15, 0];
  const directoryRva = place(Buffer.alloc(streamTypes.length * 12));

  const context = Buffer.alloc(1232);
  context.writeUInt32LE(0x10001f, 0x30);
  context.writeUInt16LE(0x33, 0x38);
  context.writeUInt32LE(0x246, 0x44);
  context.writeBigUInt64LE(0xffffffffffffffffn, 0x78); // rax
  context.writeBigUInt64LE(0x7ffe0000n, 0x98); // rsp
  context.writeBigUInt64LE(0x7ff612341234n, 0xf8); // rip
  const contextRva = place(context);
  const stack = Buffer.from("recorded-stack-bytes");
  const stackRva = place(stack);
  const name = Buffer.from("C:\\Recorded\\app.exe", "utf16le");
  const nameHeader = Buffer.alloc(4);
  nameHeader.writeUInt32LE(name.length);
  const nameRva = place(Buffer.concat([nameHeader, name]));
  const cv = Buffer.from("RSDS-recorded");
  const cvRva = place(cv);

  const system = Buffer.alloc(56);
  system.writeUInt16LE(options.architecture ?? 9, 0);
  system.writeUInt16LE(6, 2);
  system[6] = 8;
  system[7] = 1;
  system.writeUInt32LE(10, 8);
  system.writeUInt32LE(0, 12);
  system.writeUInt32LE(22631, 16);
  system.writeUInt32LE(2, 20);

  const threads = Buffer.alloc(4 + 48);
  threads.writeUInt32LE(1, 0);
  threads.writeUInt32LE(4242, 4);
  threads.writeBigUInt64LE(0x5000n, 4 + 16);
  threads.writeBigUInt64LE(0x7ffe0000n, 4 + 24);
  threads.writeUInt32LE(stack.length, 4 + 32);
  threads.writeUInt32LE(stackRva, 4 + 36);
  threads.writeUInt32LE(context.length, 4 + 40);
  threads.writeUInt32LE(contextRva, 4 + 44);

  // 8-byte padded module list, as some writers produce.
  const modules = Buffer.alloc(8 + 108);
  modules.writeUInt32LE(1, 0);
  modules.writeBigUInt64LE(0x7ff612340000n, 8);
  modules.writeUInt32LE(0x20000, 8 + 8);
  modules.writeUInt32LE(0x1234, 8 + 12);
  modules.writeUInt32LE(0x65000000, 8 + 16);
  modules.writeUInt32LE(nameRva, 8 + 20);
  modules.writeUInt32LE(cv.length, 8 + 76);
  modules.writeUInt32LE(cvRva, 8 + 80);

  const memoryList = Buffer.alloc(4 + 16);
  memoryList.writeUInt32LE(1, 0);
  memoryList.writeBigUInt64LE(0x7ffe0000n, 4);
  memoryList.writeUInt32LE(stack.length, 12);
  memoryList.writeUInt32LE(stackRva, 16);

  const exception = Buffer.alloc(168);
  exception.writeUInt32LE(4242, 0);
  exception.writeUInt32LE(0xc0000005, 8);
  exception.writeBigUInt64LE(0x7ff612341234n, 24);
  exception.writeUInt32LE(2, 32);
  exception.writeBigUInt64LE(1n, 40);
  exception.writeBigUInt64LE(0xdeadn, 48);
  exception.writeUInt32LE(context.length, 160);
  exception.writeUInt32LE(contextRva, 164);

  const misc = Buffer.alloc(24, 0x11);
  const memory64 = Buffer.alloc(16 + 16);
  const bodies = new Map<number, Buffer>([
    [7, system],
    [3, threads],
    [4, modules],
    [5, memoryList],
    [6, exception],
    [9, memory64],
    [15, misc],
    [0, Buffer.alloc(0)],
  ]);
  const streams = new Map<number, { offset: number; bytes: number }>();
  for (const type of streamTypes) {
    const body = bodies.get(type)!;
    streams.set(type, {
      offset: body.length === 0 ? 0 : place(body),
      bytes: body.length,
    });
  }
  const page = Buffer.from("memory64-page");
  const memory64Rva = align(end);
  place(page);
  memory64.writeBigUInt64LE(1n, 0);
  memory64.writeBigUInt64LE(BigInt(memory64Rva), 8);
  memory64.writeBigUInt64LE(0x10000n, 16);
  memory64.writeBigUInt64LE(BigInt(page.length), 24);

  const bytes = Buffer.concat(parts);
  // Bodies were copied by reference into parts; rewrite the patched Memory64 body.
  memory64.copy(bytes, streams.get(9)!.offset);
  bytes.writeUInt32LE(0x504d444d, 0);
  bytes.writeUInt32LE(0xa793, 4);
  bytes.writeUInt32LE(streamTypes.length, 8);
  bytes.writeUInt32LE(directoryRva, 12);
  bytes.writeUInt32LE(0x60000000, 20);
  bytes.writeBigUInt64LE(0x1n, 24);
  for (const [index, type] of streamTypes.entries()) {
    const at = directoryRva + index * 12;
    const stream = streams.get(type)!;
    bytes.writeUInt32LE(type, at);
    bytes.writeUInt32LE(stream.bytes, at + 4);
    bytes.writeUInt32LE(stream.offset, at + 8);
  }
  return { bytes, streams, directoryRva, stackRva, memory64Rva };
};
