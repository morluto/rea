import { Parser, Schema, z } from "incur";
import { expect, it } from "vitest";
import { observationDuration } from "./cliObservationOptions.js";

const options = z.object({ observationMs: observationDuration(500) });

it.each(["", " ", "\t", "0x10", "1e3", " 16 ", "+16", "16.0"])(
  "rejects a non-decimal observation duration before numeric coercion (%j)",
  (value) => {
    for (const argv of [
      [`--observation-ms=${value}`],
      ["--observation-ms", value],
    ])
      expect(() => Parser.parse(argv, { options })).toThrow();
  },
);

it.each([
  { argv: [], expected: 500 },
  { argv: ["--observation-ms=0"], expected: 0 },
  { argv: ["--observation-ms", "010"], expected: 10 },
  { argv: ["--observation-ms", "16"], expected: 16 },
])("preserves caller selection and omission ($argv)", ({ argv, expected }) => {
  expect(Parser.parse(argv, { options }).options.observationMs).toBe(expected);
});

it.each(["-1", "0.5", "NaN", "Infinity"])(
  "keeps integer and range validation (%s)",
  (value) => {
    expect(() =>
      Parser.parse(["--observation-ms", value], { options }),
    ).toThrow();
  },
);

it("advertises the decimal token guard and the domain numeric bounds", () => {
  expect(Schema.toJsonSchema(options)).toMatchObject({
    properties: {
      observationMs: {
        default: 500,
        anyOf: [
          { type: "integer", minimum: 0 },
          { type: "string", pattern: "^[0-9]+$" },
        ],
      },
    },
  });
});
