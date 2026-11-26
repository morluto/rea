import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { readArtifactFileChunks } from "../resources/readArtifactFileChunks.js";
import { readValidatedAsarEntry } from "./AsarEntryStream.js";

it.each(["complete", "truncated"])(
  "preserves %s source facts when output is cancelled after physical EOF",
  async (kind) => {
    const controller = new AbortController();
    const bytes = Buffer.from("ASAR member");
    let delivered = false;
    const read = (async (target: Buffer) => {
      if (delivered) return { bytesRead: 0, buffer: target };
      delivered = true;
      bytes.copy(target);
      return { bytesRead: bytes.length, buffer: target };
    }) as FileHandle["read"];
    const source = readArtifactFileChunks(
      { read },
      { signal: controller.signal },
    );
    const output = readValidatedAsarEntry(
      source,
      bytes.length + (kind === "truncated" ? 1 : 0),
      "member",
      "/fixture/archive.asar",
      controller.signal,
    );
    const failed = new Promise<Error>((resolve) =>
      output.once("error", resolve),
    );
    output.read(0);
    await expect.poll(() => source.readCoverage().kind).toBe("complete");
    expect(output.readableLength).toBeGreaterThan(0);
    expect(output.readableEnded).toBe(false);
    controller.abort(null);
    await expect(failed).resolves.toMatchObject(
      kind === "complete"
        ? { reason: "cancelled", cancellation: { reason: null } }
        : { reason: "integrity", integrityCheck: "declared-size" },
    );
  },
);

/** One complete physical read of `bytes`, as an ASAR member source. */
const memberSource = (bytes: Buffer) => {
  let delivered = false;
  const read = (async (target: Buffer) => {
    if (delivered) return { bytesRead: 0, buffer: target };
    delivered = true;
    bytes.copy(target);
    return { bytesRead: bytes.length, buffer: target };
  }) as FileHandle["read"];
  return readArtifactFileChunks({ read });
};

it.each([
  ["exceed", -1],
  ["fall short of", 1],
] as const)(
  "names the declared-size check when the bytes %s the header size",
  async (_label, delta) => {
    const bytes = Buffer.from("ASAR member");
    const output = readValidatedAsarEntry(
      memberSource(bytes),
      bytes.length + delta,
      "member",
      "/fixture/archive.asar",
    );
    await expect(output.toArray()).rejects.toMatchObject({
      reason: "integrity",
      integrityCheck: "declared-size",
    });
  },
);

it("names the read-coverage check when the source ends without coverage", async () => {
  const source = Object.assign(Readable.from([Buffer.from("partial")]), {
    readCoverage: () => ({ kind: "incomplete" as const, bytes: 7n }),
  });
  const output = readValidatedAsarEntry(
    source,
    undefined,
    "member",
    "/fixture/archive.asar",
  );
  await expect(output.toArray()).rejects.toMatchObject({
    reason: "integrity",
    integrityCheck: "read-coverage",
  });
});
