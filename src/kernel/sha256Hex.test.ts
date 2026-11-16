import { expect, it } from "vitest";

import { sha256Hex } from "./sha256Hex.js";

const EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

it("digests empty input as the SHA-256 of no bytes", () => {
  expect(sha256Hex("")).toBe(EMPTY);
  expect(sha256Hex(Buffer.alloc(0))).toBe(EMPTY);
  expect(sha256Hex(new Uint8Array(0))).toBe(EMPTY);
});

it("hashes strings as UTF-8 unless an encoding is named", () => {
  expect(sha256Hex("é")).toBe(sha256Hex(Buffer.from("é", "utf8")));
  expect(sha256Hex("é", "latin1")).toBe(sha256Hex(Buffer.from([0xe9])));
  expect(sha256Hex("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
