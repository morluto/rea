import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** The pinned pure-JS decoder, used in tests to build real streams. */
const lzmaPurescript = createRequire(import.meta.url)(
  "lzma-purejs",
) as unknown as {
  compressFile: (
    buffer: Buffer,
    output?: undefined,
    options?: { eos: boolean },
  ) => Uint8Array;
};

interface UefiLzmaWorkerReply {
  readonly ok: unknown;
  readonly reason?: unknown;
  readonly message?: unknown;
  readonly lzma_version?: unknown;
  readonly input_bytes_consumed?: unknown;
  readonly output?: { readonly sha256: unknown; readonly bytes: unknown };
}

const runLzmaWorker = async (
  directory: string,
  payload: Buffer,
  maxOutputBytes: number,
): Promise<UefiLzmaWorkerReply> => {
  const payloadPath = join(directory, "payload.lzma");
  const outputPath = join(directory, "output.bin");
  const replyPath = join(directory, "reply.json");
  const requestPath = join(directory, "request.json");
  await writeFile(payloadPath, payload);
  await writeFile(
    requestPath,
    JSON.stringify({
      format: "lzma",
      payload_path: payloadPath,
      output_path: outputPath,
      reply_path: replyPath,
      max_output_bytes: maxOutputBytes,
    }),
  );
  await promisify(execFile)(
    process.execPath,
    [
      "--max-old-space-size=256",
      "--disable-wasm-trap-handler",
      fileURLToPath(
        new URL("../../../dist/uefi/UefiLzmaWorker.js", import.meta.url),
      ),
      requestPath,
    ],
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(await readFile(replyPath, "utf8")) as UefiLzmaWorkerReply;
};

/** Real compiled worker and pinned decoder; no provider-admission claim. */
it("decompresses a real lzma-purejs stream through the actual worker", async () => {
  const directory = await createTestTempDirectory("rea-uefi-lzma-");
  const plain = Buffer.from(
    "B550 AORUS Elite V2 firmware module payload. ".repeat(40),
  );
  const reply = await runLzmaWorker(
    directory,
    Buffer.from(lzmaPurescript.compressFile(plain)),
    1024 * 1024,
  );
  expect(reply.ok, JSON.stringify(reply)).toBe(true);
  expect(reply.lzma_version).toBe("0.9.3");
  expect(reply.output?.bytes).toBe(plain.length);
  expect(reply.output?.sha256).toBe(
    createHash("sha256").update(plain).digest("hex"),
  );
  expect((await readFile(join(directory, "output.bin"))).equals(plain)).toBe(
    true,
  );
});

it("reports a typed failure for an undecodable stream", async () => {
  const directory = await createTestTempDirectory("rea-uefi-lzma-");
  // Valid property byte, corrupt LZMA stream behind it.
  const reply = await runLzmaWorker(
    directory,
    Buffer.from([0x5d, 0x00, 0x00, 0x80, 0x00, 0x11, 0x22, 0x33, 0x44]),
    1024 * 1024,
  );
  expect(reply.ok).toBe(false);
  expect(reply.message, JSON.stringify(reply)).not.toBe("");
  expect(["format", "decoder"]).toContain(reply.reason);
});

it("honors the caller's output budget as an output-limit failure", async () => {
  const directory = await createTestTempDirectory("rea-uefi-lzma-");
  const plain = Buffer.from(
    "decompressed payload beyond the tight budget".repeat(5),
  );
  const reply = await runLzmaWorker(
    directory,
    Buffer.from(lzmaPurescript.compressFile(plain)),
    16,
  );
  expect(reply.ok).toBe(false);
  expect(reply.reason).toBe("output-limit");
  await expect(readFile(join(directory, "output.bin"))).rejects.toThrow();
});

it("checks the declared dictionary before the decoder allocates its window", async () => {
  const directory = await createTestTempDirectory("rea-uefi-lzma-");
  const stream = Buffer.from(
    lzmaPurescript.compressFile(Buffer.from("small firmware payload")),
  );
  stream.writeUInt32LE(128 * 1024 * 1024, 1);
  const reply = await runLzmaWorker(directory, stream, 1024);
  expect(reply).toMatchObject({
    ok: false,
    reason: "output-limit",
    message: expect.stringContaining("dictionary"),
  });
});

it("uses the EDK II minimum effective dictionary size for match distances", async () => {
  const directory = await createTestTempDirectory("rea-uefi-lzma-small-dict-");
  const plain = Buffer.from(
    "Static firmware bytes for the dictionary fixture. ".repeat(50),
  );
  const input = Buffer.from(lzmaPurescript.compressFile(plain));
  input.writeUInt32LE(16, 1);
  const reply = await runLzmaWorker(directory, input, plain.length);
  expect(reply).toMatchObject({
    ok: true,
    input_bytes_consumed: input.length,
  });
  expect((await readFile(join(directory, "output.bin"))).equals(plain)).toBe(
    true,
  );
});

it("rejects an incomplete coded body even when its declared output size is plausible", async () => {
  const directory = await createTestTempDirectory("rea-uefi-lzma-eof-");
  const input = Buffer.from(
    lzmaPurescript.compressFile(
      Buffer.from("Ordinary test data for the LZMA worker's read boundary."),
    ),
  );
  const reply = await runLzmaWorker(directory, input.subarray(0, -1), 1024);
  expect(reply).toMatchObject({ ok: false, reason: "format" });
  await expect(readFile(join(directory, "output.bin"))).rejects.toThrow();
});

it("rejects a nonzero LZMA range coder lead-in", async () => {
  const directory = await createTestTempDirectory("rea-uefi-lzma-range-");
  const input = Buffer.from(
    lzmaPurescript.compressFile(Buffer.from("static firmware fixture")),
  );
  input[13] = 1;
  const reply = await runLzmaWorker(directory, input, 1024);
  expect(reply).toMatchObject({
    ok: false,
    reason: "format",
    message: expect.stringContaining("range coder byte must be zero"),
  });
  await expect(readFile(join(directory, "output.bin"))).rejects.toThrow();
});

it.each([false, true])(
  "accounts for input consumption with an end marker (unknown size %s)",
  async (unknownSize) => {
    const plain = Buffer.from("UEFI audit fixture");
    const markerless = lzmaPurescript.compressFile(plain);
    const withMarker = Buffer.from(
      lzmaPurescript.compressFile(plain, undefined, { eos: true }),
    );
    expect(withMarker.length).toBeGreaterThan(markerless.length);
    if (unknownSize) withMarker.writeBigUInt64LE(0xffffffffffffffffn, 5);
    const input = Buffer.concat([
      withMarker,
      Buffer.from("unread fixture bytes"),
    ]);
    const directory = await createTestTempDirectory("rea-uefi-lzma-marker-");
    const reply = await runLzmaWorker(directory, input, 1024);
    // A declared output size lets the decoder stop before a legal optional marker.
    expect(reply).toMatchObject({
      ok: true,
      input_bytes_consumed: unknownSize ? withMarker.length : markerless.length,
    });
    expect((await readFile(join(directory, "output.bin"))).equals(plain)).toBe(
      true,
    );
  },
);
