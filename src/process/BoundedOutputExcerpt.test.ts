import { describe, expect, it } from "vitest";

import { BoundedOutputExcerpt } from "./BoundedOutputExcerpt.js";

describe("bounded output excerpts", () => {
  it.each([
    { text: `A🙂${"x".repeat(30)}🙂Z`, limit: 8, head: "A", tail: "Z" },
    {
      text: `é中🙂${"x".repeat(30)}🙂中é`,
      limit: 16,
      head: "é中",
      tail: "中é",
    },
    { text: `é${"x".repeat(30)}中`, limit: 1, head: "", tail: "" },
  ])(
    "omits only cut UTF-8 code points with a $limit byte budget",
    ({ text, limit, head, tail }) => {
      const bytes = Buffer.from(text);
      for (let split = 0; split <= bytes.length; split += 1) {
        const excerpt = new BoundedOutputExcerpt(limit);
        excerpt.append(bytes.subarray(0, split));
        excerpt.append(bytes.subarray(split));
        expect(excerpt.truncated).toBe(true);
        expect(excerpt.text).toBe(`${head} … [output omitted] … ${tail}`);
      }
    },
  );

  it("rejoins multibyte characters across the head/tail boundary without truncation", () => {
    const bytes = Buffer.from("A🙂");
    for (let split = 0; split <= bytes.length; split += 1) {
      const excerpt = new BoundedOutputExcerpt(bytes.length);
      excerpt.append(bytes.subarray(0, split));
      excerpt.append(bytes.subarray(split));
      expect(excerpt.truncated).toBe(false);
      expect(excerpt.text).toBe("A🙂");
    }
    const bytewise = new BoundedOutputExcerpt(bytes.length);
    for (const byte of bytes) bytewise.append(Buffer.from([byte]));
    expect(bytewise.truncated).toBe(false);
    expect(bytewise.text).toBe("A🙂");
  });

  it.each([
    { suffix: [0xc0], decoded: "�" },
    { suffix: [0xc1], decoded: "�" },
    { suffix: [0xf5], decoded: "�" },
    { suffix: [0xff], decoded: "�" },
    { suffix: [0x80], decoded: "�" },
    { suffix: [0xe0, 0x9f], decoded: "��" },
    { suffix: [0xed, 0xa0], decoded: "��" },
    { suffix: [0xf0, 0x8f], decoded: "��" },
    { suffix: [0xf4, 0x90], decoded: "��" },
    { suffix: [0xf0, 0x8f, 0x80], decoded: "���" },
    { suffix: [0xf4, 0x90, 0x80], decoded: "���" },
    { suffix: [0xc2], decoded: "" },
    { suffix: [0xe0], decoded: "" },
    { suffix: [0xe0, 0xa0], decoded: "" },
    { suffix: [0xed, 0x9f], decoded: "" },
    { suffix: [0xf0], decoded: "" },
    { suffix: [0xf0, 0x90], decoded: "" },
    { suffix: [0xf0, 0x90, 0x80], decoded: "" },
    { suffix: [0xf4, 0x8f], decoded: "" },
    { suffix: [0xf4, 0x8f, 0xbf], decoded: "" },
  ])(
    "omits only valid incomplete UTF-8 head suffixes: $suffix",
    ({ suffix, decoded }) => {
      const head = Buffer.from([0x41, ...suffix]);
      const tail = `${"B".repeat(head.length - 1)}Z`;
      const bytes = Buffer.concat([
        head,
        Buffer.from("x".repeat(30)),
        Buffer.from(tail),
      ]);
      for (let split = 0; split <= bytes.length; split += 1) {
        const excerpt = new BoundedOutputExcerpt(head.length * 2);
        excerpt.append(bytes.subarray(0, split));
        excerpt.append(bytes.subarray(split));
        expect(excerpt.truncated).toBe(true);
        expect(excerpt.text).toBe(`A${decoded} … [output omitted] … ${tail}`);
      }
    },
  );

  it("preserves malformed output inside the retained head and tail", () => {
    const excerpt = new BoundedOutputExcerpt(4);
    excerpt.append(
      Buffer.concat([
        Buffer.from([0xff, 0x41]),
        Buffer.from("x".repeat(30)),
        Buffer.from([0x42, 0xff]),
      ]),
    );
    expect(excerpt.text).toBe("�A … [output omitted] … B�");
  });
});
