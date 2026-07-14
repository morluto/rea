import { describe, expect, it } from "vitest";

import {
  boundedSensitiveText,
  redactSensitiveText,
} from "../src/browser/SensitiveTextCapture.js";

describe("sensitive console text", () => {
  it("redacts assignments, bearer credentials, and JWT-shaped values", () => {
    const jwt = "eyJabcdefghijk.abcdefghijkl.abcdefghijk";
    expect(
      redactSensitiveText(
        `authorization=Bearer abc.def password='hunter2' api_key=key ${jwt}`,
      ),
    ).toBe(
      "authorization=[REDACTED] password=[REDACTED] api_key=[REDACTED] [REDACTED_JWT]",
    );
  });

  it("bounds UTF-8 after redaction without splitting a code point", () => {
    expect(boundedSensitiveText("password=secret 你好", 22)).toEqual({
      text: "password=[REDACTED] ",
      bytes: 20,
      truncated: true,
    });
  });
});
