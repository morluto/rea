import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import {
  encodeUnityLzma,
  encodeUnityLzmaWithEndMarker,
  LIBLZMA_UNITY_BLOCK,
  LIBLZMA_UNITY_PLAIN,
} from "../../tests/fixtures/unityfs.js";
import { decodeUnityLzmaBlock } from "./LzmaUnityBlock.js";

it("decodes a Unity LZMA block to its declared size", async () => {
  const plain = Buffer.from("unityfs lzma member bytes ".repeat(8));
  const budget = 64 * 1024 * 1024;
  expect(
    (
      await decodeUnityLzmaBlock(encodeUnityLzma(plain), plain.length, budget)
    ).equals(plain),
  ).toBe(true);
});

it("accepts a Unity LZMA block that still carries an end marker", async () => {
  const plain = Buffer.from("unityfs lzma end marker bytes ".repeat(8));
  const budget = 64 * 1024 * 1024;
  expect(
    (
      await decodeUnityLzmaBlock(
        encodeUnityLzmaWithEndMarker(plain),
        plain.length,
        budget,
      )
    ).equals(plain),
  ).toBe(true);
});

it("decodes a stream from an independent encoder that ends in a marker", async () => {
  // liblzma, not lzma-purejs, produced these bytes, so a shared encoder bug
  // cannot make this round-trip pass.
  const decoded = await decodeUnityLzmaBlock(
    LIBLZMA_UNITY_BLOCK,
    LIBLZMA_UNITY_PLAIN.length,
    64 * 1024 * 1024,
  );
  expect(decoded.equals(LIBLZMA_UNITY_PLAIN)).toBe(true);
});

it("decodes a small block whose dictionary exceeds the output budget", async () => {
  // A dictionary sizes the decoder window, not the output. 256 MiB on a
  // 64-byte block is valid LZMA and needs no more than a 4 KiB window.
  const plain = Buffer.from("small block, large dictionary ".repeat(2));
  const encoded = Buffer.from(encodeUnityLzma(plain));
  encoded.writeUInt32LE(256 * 1024 * 1024, 1);
  const decoded = await decodeUnityLzmaBlock(encoded, plain.length, 1024);
  expect(decoded.equals(plain)).toBe(true);
});

it.each([
  { lc: 4, lp: 1, pb: 2 },
  { lc: 8, lp: 4, pb: 4 },
])(
  "decodes LZMA1 literal bits beyond the LZMA2 lc + lp limit (%o)",
  async (bits) => {
    // The LZMA specification admits lc 0-8, lp 0-4 and pb 0-4 for LZMA1.
    const plain = Buffer.from("literal context bits ".repeat(12));
    const decoded = await decodeUnityLzmaBlock(
      encodeUnityLzma(plain, bits),
      plain.length,
      64 * 1024 * 1024,
    );
    expect(decoded.equals(plain)).toBe(true);
  },
);

it("refuses trailing bytes that are not an end marker", async () => {
  const plain = Buffer.from("unityfs lzma trailing");
  const budget = 64 * 1024 * 1024;
  const encoded = Buffer.concat([
    encodeUnityLzma(plain),
    Buffer.from([0x01, 0x02, 0x03, 0x04]),
  ]);
  await expect(
    decodeUnityLzmaBlock(encoded, plain.length, budget),
  ).rejects.toMatchObject({ kind: "malformed" });
});

it("refuses a truncated Unity LZMA header", async () => {
  await expect(
    decodeUnityLzmaBlock(Buffer.from([0x5d, 0, 0]), 4, 4),
  ).rejects.toMatchObject({
    kind: "malformed",
  });
});

it("refuses Unity LZMA properties outside the decoder range", async () => {
  await expect(
    decodeUnityLzmaBlock(
      // 225 is the first value past (pb * 5 + lp) * 9 + lc with all maxima.
      Buffer.from([225, 0, 0, 0x80, 0, 0, 1, 2, 3, 4]),
      1,
      1,
    ),
  ).rejects.toMatchObject({ kind: "malformed" });
});

it("refuses a Unity LZMA stream that cannot finish", async () => {
  await expect(
    decodeUnityLzmaBlock(Buffer.from([0x5d, 0, 0, 0, 1, 0, 0xff, 0xff]), 8, 8),
  ).rejects.toMatchObject({ kind: "malformed" });
});

it("refuses a decode whose declared length exceeds the budget", async () => {
  await expect(
    decodeUnityLzmaBlock(encodeUnityLzma(Buffer.from("x")), 2, 1),
  ).rejects.toMatchObject({ kind: "limit" });
});

it("reports a stream that exceeds its declared size as malformed, not over budget", async () => {
  // A nonempty stream with a zero declaration overruns during decode; that is
  // a size mismatch. Declarations above maximumBytes are refused separately.
  await expect(
    decodeUnityLzmaBlock(encodeUnityLzma(Buffer.from("overrun")), 0, 64),
  ).rejects.toMatchObject({ kind: "malformed" });
});

it("preserves timer-driven cancellation during Unity LZMA decode", async () => {
  const plain = Buffer.alloc(2 * 1024 * 1024, 0x61);
  const budget = 64 * 1024 * 1024;
  const encoded = encodeUnityLzma(plain);
  const controller = new AbortController();
  const reason = new Error("cancel during lzma decode");
  const pending = decodeUnityLzmaBlock(
    encoded,
    plain.length,
    budget,
    controller.signal,
  );
  globalThis.setImmediate(() => {
    controller.abort(reason);
  });
  await expect(pending).rejects.toMatchObject({
    reason: "cancelled",
    cause: reason,
  });
});

it.each(["cancellation", "completion"] as const)(
  "settles a decode only after its worker has exited (%s)",
  async (ending) => {
    // The decode owns the worker and its memory until termination completes.
    let exited = false;
    const terminate = Worker.prototype.terminate;
    const spy = vi
      .spyOn(Worker.prototype, "terminate")
      .mockImplementation(function (this: Worker) {
        return terminate.call(this).then((code) => {
          exited = true;
          return code;
        });
      });
    try {
      const plain =
        ending === "completion"
          ? Buffer.from("settles after worker exit ".repeat(4))
          : Buffer.alloc(2 * 1024 * 1024, 0x61);
      const controller = new AbortController();
      let exitedAtSettle: boolean | undefined;
      const pending = decodeUnityLzmaBlock(
        encodeUnityLzma(plain),
        plain.length,
        64 * 1024 * 1024,
        controller.signal,
      ).finally(() => {
        exitedAtSettle = exited;
      });
      if (ending === "cancellation")
        globalThis.setImmediate(() => {
          controller.abort(new Error("cancel before exit"));
        });
      await pending.then(
        () => undefined,
        () => undefined,
      );
      expect(spy).toHaveBeenCalled();
      expect(exitedAtSettle).toBe(true);
    } finally {
      spy.mockRestore();
    }
  },
);
