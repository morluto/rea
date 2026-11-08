import { expect, it } from "vitest";
import {
  estimateSemanticReturnValueBytes,
  flattenSemanticReturnValue,
} from "./javascriptSemanticReturns.js";
import type { JavaScriptSemanticValue } from "./javascriptSemanticValueTypes.js";

it("stops an expanded return-shape forecast at capacity without constructing ancestor paths", () => {
  let value: JavaScriptSemanticValue = { status: "literal", value: 1 };
  for (let i = 0; i < 128; i++)
    value = {
      status: "object",
      properties: [{ name: "key".repeat(1024), presence: "present", value }],
      unknownProperties: false,
      omittedProperties: 0,
    };
  expect(estimateSemanticReturnValueBytes(value, 16 * 1024)).toBe(
    16 * 1024 + 1,
  );
});
it("covers escaped JSON-pointer path expansion and literal payloads", () => {
  const value: JavaScriptSemanticValue = {
    status: "object",
    properties: [
      {
        name: 'a/b~c"',
        presence: "present",
        value: { status: "literal", value: "payload" },
      },
    ],
    unknownProperties: false,
    omittedProperties: 0,
  };
  const measured = estimateSemanticReturnValueBytes(value, 1024 * 1024);
  expect(measured).toBeGreaterThanOrEqual(
    Buffer.byteLength(JSON.stringify(flattenSemanticReturnValue(value))),
  );
});
