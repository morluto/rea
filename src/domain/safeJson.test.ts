import { expect, it } from "vitest";

import { decodeUtf8Json, safeParseJson } from "./safeJson.js";

it("keeps the original JSON parse failure as the cause", () => {
  const parsed = safeParseJson("{");

  if (parsed.ok) throw new Error("expected invalid JSON to fail");
  expect(parsed.error).toContain("JSON");
  expect(parsed.cause).toBeInstanceOf(SyntaxError);
});

it("decodes strict UTF-8 JSON bytes without a byte-order mark", () => {
  const decoded = decodeUtf8Json(
    Buffer.from('{"message":"valid é and 😀"}', "utf8"),
  );

  if (!decoded.ok) throw new Error("expected valid UTF-8 to decode");
  expect(decoded.text).toBe('{"message":"valid é and 😀"}');
});

it("classifies invalid UTF-8 bytes as invalid-utf8 with the cause", () => {
  const decoded = decodeUtf8Json(
    Buffer.concat([
      Buffer.from('{"message":"'),
      Buffer.from([0x80]),
      Buffer.from('"}'),
    ]),
  );

  if (decoded.ok) throw new Error("expected invalid UTF-8 to fail");
  expect(decoded.reason).toBe("invalid-utf8");
  expect(decoded.cause).toBeInstanceOf(TypeError);
});
