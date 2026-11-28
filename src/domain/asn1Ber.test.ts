import { expect, it } from "vitest";

import {
  ASN1_MAX_TAG_NUMBER_OCTETS,
  Asn1BerFailure,
  Asn1BerReader,
  readAsn1BerHeader,
} from "./asn1Ber.js";

const read = (bytes: number[]) =>
  new Asn1BerReader(Buffer.from(bytes), 64).read();

it("keeps the identifier octet and number for a low tag", () => {
  const node = read([0x30, 0x03, 0x02, 0x01, 0x05]);
  expect(node).toMatchObject({
    tag: 0x30,
    tagClass: "universal",
    tagNumber: 16,
    constructed: true,
    contentStart: 2,
    end: 5,
  });
  expect(node.children[0]).toMatchObject({ tag: 0x02, tagNumber: 2 });
});

it("decodes a private high-tag-number four-character code", () => {
  // [PRIVATE 'MANB'] { SEQUENCE {} }: 0x4d414e42 in base-128 groups.
  const node = read([0xff, 0x84, 0xea, 0x85, 0x9c, 0x42, 0x02, 0x30, 0x00]);
  expect(node).toMatchObject({
    tag: 0xff,
    tagClass: "private",
    tagNumber: 0x4d414e42,
    constructed: true,
    contentStart: 7,
    end: 9,
  });
  expect(node.children[0]).toMatchObject({ tag: 0x30, start: 7 });
});

it("reports identifier and header lengths without reading content", () => {
  expect(
    readAsn1BerHeader(Uint8Array.from([0xbf, 0x81, 0x00, 0x82, 0x01, 0x00])),
  ).toEqual({
    tag: 0xbf,
    tagClass: "context",
    tagNumber: 128,
    constructed: true,
    identifierLength: 3,
    headerLength: 6,
    length: 256,
  });
  expect(readAsn1BerHeader(Uint8Array.from([0x30, 0x80]))).toMatchObject({
    headerLength: 2,
    length: null,
  });
});

it("rejects malformed and unbounded high tag numbers", () => {
  const malformed = [
    // Tag number 1 must use the low-tag form.
    [0x1f, 0x01, 0x00],
    // A leading zero continuation octet.
    [0x1f, 0x80, 0x20, 0x00],
    // Continuation never ends inside the value.
    [0x1f, 0x81],
    // More continuation octets than the allowance.
    [0x1f, ...Array<number>(ASN1_MAX_TAG_NUMBER_OCTETS).fill(0x81), 0x01, 0x00],
  ];
  for (const bytes of malformed) {
    expect(() => read(bytes)).toThrow(Asn1BerFailure);
    expect(() => read(bytes)).toThrow(
      expect.objectContaining({
        failure: expect.objectContaining({ kind: "malformed" }),
      }),
    );
  }
});

it("marks failures where the input ends early as truncated", () => {
  const failure = (bytes: number[]): Asn1BerFailure => {
    try {
      new Asn1BerReader(Buffer.from(bytes), 64, 8).read();
    } catch (cause: unknown) {
      if (cause instanceof Asn1BerFailure) return cause;
      throw cause;
    }
    throw new Error("expected an Asn1BerFailure");
  };
  expect(failure([0x30]).truncated).toBe(true);
  expect(failure([0x04, 0x82, 0x01]).truncated).toBe(true);
  expect(failure([0x30, 0x03, 0x04, 0x05, 0x00]).truncated).toBe(true);
  expect(failure([0x30, 0x80, 0x05, 0x00]).truncated).toBe(true);
  expect(failure([0x04, 0x80, 0x00, 0x00]).truncated).toBe(false);
  expect(failure([0x04, 0x85, 1, 2, 3, 4, 5]).truncated).toBe(false);
});
