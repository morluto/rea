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
    const bytes = Buffer.from("é中🙂");
    const excerpt = new BoundedOutputExcerpt(bytes.length);
    for (const byte of bytes) excerpt.append(Buffer.from([byte]));
    expect(excerpt.truncated).toBe(false);
    expect(excerpt.text).toBe("é中🙂");
  });

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
