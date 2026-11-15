import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { finished } from "node:stream/promises";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { openRegularFile } from "../../filesystem/RegularFile.js";
import { artifactReaderLifecycleCases } from "../../../tests/fixtures/artifactReaderLifecycle.js";
import { DenoStandaloneArtifactReader } from "../DenoStandaloneArtifactReader.js";
import { buildDenoSection, denoElf } from "./DenoStandalone.fixture.js";

artifactReaderLifecycleCases({
  image: () => denoElf(),
  createReader: (path, admitted) =>
    new DenoStandaloneArtifactReader(path, admitted),
});

it("rejects carrier mutation between physical member reads", async () => {
  const path = join(
    await createTestTempDirectory("rea-deno-member-change-"),
    "carrier",
  );
  await writeFile(
    path,
    denoElf(buildDenoSection({ vfsFileData: Buffer.alloc(128 * 1024, 0x41) })),
  );
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new DenoStandaloneArtifactReader(path, admitted);
  const nativeRead = admitted.handle.read.bind(admitted.handle);
  let changed = false;
  let reads: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const entry = entries[0];
    if (entry?.byteOffset == null) throw new Error("Missing Deno member");
    const start = entry.byteOffset;
    reads = vi.spyOn(admitted.handle, "read").mockImplementation((async (
      ...args: unknown[]
    ) => {
      const result = await Reflect.apply(nativeRead, admitted.handle, args);
      if (!changed && args[3] === BigInt(start)) {
        changed = true;
        const writer = await open(path, "r+");
        try {
          await writer.write(
            Buffer.alloc(65536, 0x42),
            0,
            65536,
            start + 65536,
          );
        } finally {
          await writer.close();
        }
      }
      return result;
    }) as typeof admitted.handle.read);
    const outcome = await buffer(await reader.open(entry)).then(
      () => ({ kind: "completed" as const }),
      (cause: unknown) => ({ kind: "failed" as const, cause }),
    );
    expect(outcome).toMatchObject({
      kind: "failed",
      cause: { reason: "integrity" },
    });
    expect(changed).toBe(true);
  } finally {
    reads?.mockRestore();
    await reader.close();
    await admitted.handle.close();
  }
});

it("keeps already validated buffered bytes when the carrier changes after production", async () => {
  const contents = Buffer.from("inert completed member");
  const path = join(
    await createTestTempDirectory("rea-deno-completed-member-"),
    "carrier",
  );
  await writeFile(path, denoElf(buildDenoSection({ vfsFileData: contents })));
  const reader = new DenoStandaloneArtifactReader(path);
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const entry = entries[0];
    if (entry === undefined) throw new Error("Missing Deno member");
    const stream = await reader.open(entry);
    await finished(stream, { readable: false, cleanup: true });
    await writeFile(path, "replacement after completed production");
    expect((await buffer(stream)).equals(contents)).toBe(true);
  } finally {
    await reader.close();
  }
});
