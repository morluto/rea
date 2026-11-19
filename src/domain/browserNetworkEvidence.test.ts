import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import { browserNetworkBodySchema } from "./browserNetworkEvidence.js";

const bytes = Buffer.from([0xff, 0, 0xfe]);
const retained = {
  state: "captured",
  representation: "browser-decoded-response-bytes",
  encoding: "base64",
  content: bytes.toString("base64"),
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  media_type: null,
  redacted: false,
};

it("validates the actual retained bytes against canonical base64, count, and digest", () => {
  expect(browserNetworkBodySchema.safeParse(retained).success).toBe(true);
  expect(
    browserNetworkBodySchema.safeParse({
      ...retained,
      representation: "playwright-response-body-bytes",
    }).success,
  ).toBe(true);
  for (const mutation of [
    { bytes: 4 },
    { sha256: "0".repeat(64) },
    { content: `${retained.content}\n` },
  ])
    expect(
      browserNetworkBodySchema.safeParse({ ...retained, ...mutation }).success,
    ).toBe(false);
});

it("authenticates the entire body across base64 windows and a padded tail", () => {
  const bytes = Buffer.alloc(100_001, 0x41);
  bytes[48 * 1024] = 0xff;
  bytes[bytes.length - 1] = 0xfe;
  const body = {
    ...retained,
    bytes: bytes.length,
    content: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  expect(browserNetworkBodySchema.safeParse(body).success).toBe(true);
  bytes[48 * 1024] = 0;
  expect(
    browserNetworkBodySchema.safeParse({
      ...body,
      content: bytes.toString("base64"),
    }).success,
  ).toBe(false);
});

it("rejects padding at a nonfinal base64 window boundary", () => {
  const first = Buffer.alloc(48 * 1024 - 1, 0x41);
  const last = Buffer.from([0x42, 0x43, 0x44]);
  expect(
    browserNetworkBodySchema.safeParse({
      ...retained,
      content: first.toString("base64") + last.toString("base64"),
      bytes: first.length + last.length,
      sha256: createHash("sha256").update(first).update(last).digest("hex"),
    }).success,
  ).toBe(false);
});
