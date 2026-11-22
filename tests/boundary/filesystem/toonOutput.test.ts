import { constants } from "node:buffer";
import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";

import { decode, encode } from "@toon-format/toon";
import { expect, it, vi } from "vitest";

import { createCliResultOutput } from "../../../src/cli/cliResultOutput.js";
import { parseCliOutputArguments } from "../../../src/cliOutput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("node:fs/promises", { spy: true });

const metadata = { command: "fixture", duration: "1ms" };
const outputFor = (destination: Writable) => {
  const output = createCliResultOutput(
    parseCliOutputArguments([]),
    destination,
  );
  if (output === undefined) throw new Error("missing output surface");
  return output;
};

it("writes staged TOON bytes identical to the ordinary encoder", async () => {
  const value = {
    rows: Array.from({ length: 800 }, (_, id) => ({
      id,
      name: "x".repeat(1600) + ' 🧪, "quote"\nline',
    })),
  };
  const expected = `${encode(value)}\n`;
  const observed = createHash("sha256");
  let writes = 0;
  const output = outputFor(
    new Writable({
      highWaterMark: 1,
      write(part: Buffer, _encoding, callback) {
        writes++;
        observed.update(part);
        setImmediate(callback);
      },
    }),
  );
  expect(await output.write(value, metadata)).toBe(true);
  expect(output.failed).toBe(false);
  expect(writes).toBeGreaterThan(1);
  expect(observed.digest("hex")).toBe(
    createHash("sha256").update(expected).digest("hex"),
  );
});

it("reports a late oversized TOON line before any document bytes are written", async () => {
  const leaf = "x".repeat(64 * 1024);
  const prefix = Array.from({ length: 20 }, () => ({ text: leaf }));
  const lateLine = Array.from(
    { length: Math.ceil(constants.MAX_STRING_LENGTH / leaf.length) + 1 },
    () => leaf,
  );
  const parts: Buffer[] = [];
  const output = outputFor(
    new Writable({
      write(part: Buffer, _encoding, callback) {
        parts.push(part);
        callback();
      },
    }),
  );
  expect(await output.write({ prefix, lateLine }, metadata)).toBe(true);
  const text = Buffer.concat(parts).toString("utf8");
  expect(text).not.toContain("prefix[");
  expect(decode(text)).toMatchObject({
    code: "resource_constraint",
    remediation: { action: expect.stringContaining("--format json") },
  });
});

it("cleans staged output after a destination failure", async () => {
  const cause = new Error("destination closed");
  const path = await createTestTempDirectory("rea-toon-output-");
  const tmp = process.platform === "win32" ? "TEMP" : "TMPDIR";
  const previous = process.env[tmp];
  process.env[tmp] = path;
  try {
    expect(tmpdir()).toBe(path);
    const output = outputFor(
      new Writable({
        write(_part, _encoding, callback) {
          callback(cause);
        },
      }),
    );
    const value = {
      rows: Array.from({ length: 20 }, () => ({
        value: "x".repeat(64 * 1024),
      })),
    };
    await expect(output.write(value, metadata)).rejects.toBe(cause);
    expect(output.failed).toBe(true);
    expect(await readdir(path)).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env[tmp];
    else process.env[tmp] = previous;
  }
});

it("returns a typed refusal if temporary storage runs out before stdout starts", async () => {
  vi.mocked(open).mockRejectedValueOnce(
    Object.assign(new Error("disk full"), { code: "ENOSPC" }),
  );
  const chunks: Buffer[] = [];
  const output = outputFor(
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    }),
  );
  const leaf = "x".repeat(64 * 1024);
  const rows = Array.from({ length: 20 }, () => ({ text: leaf }));
  expect(await output.write({ rows }, metadata)).toBe(true);
  const text = Buffer.concat(chunks).toString("utf8");
  expect(text).not.toContain("rows[");
  expect(decode(text)).toMatchObject({
    code: "resource_constraint",
    details: { reported_limits: { system_code: "ENOSPC" } },
    remediation: { action: expect.stringContaining("--format json") },
  });
});
