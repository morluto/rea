import { expect, it } from "vitest";
import { ZodError } from "zod";
import { parsePacketOutput } from "../../../src/captures/parsePacketOutput.js";

it("preserves repeated field values and missing fields while discarding export index metadata", () => {
  const output = JSON.stringify([
    {
      _index: "packets-2026",
      _score: null,
      _source: {
        layers: {
          "frame.number": ["2"],
          "ip.addr": ["192.0.2.1", "192.0.2.2"],
        },
      },
    },
    { _source: { layers: { "frame.number": ["7"] } } },
  ]);
  expect(parsePacketOutput(output, 7)).toEqual({
    ok: true,
    value: [
      { "frame.number": ["2"], "ip.addr": ["192.0.2.1", "192.0.2.2"] },
      { "frame.number": ["7"] },
    ],
  });
});

it.each([
  {
    layers: { "ip.addr": ["192.0.2.1"] },
    issue: {
      code: "invalid_type",
      path: [0, "frame.number"],
    },
  },
  {
    layers: { "frame.number": ["1"], "ip.addr": "192.0.2.1" },
    issue: { code: "invalid_type", path: [0, "ip.addr"] },
  },
  {
    layers: { "frame.number": ["0"] },
    issue: {
      code: "invalid_format",
      path: [0, "frame.number", 0],
    },
  },
  {
    layers: { "frame.number": ["1", "2"] },
    issue: { code: "too_big", path: [0, "frame.number"] },
  },
])("rejects malformed producer fields: $layers", ({ layers, issue }) => {
  const parsed = parsePacketOutput(
    JSON.stringify([{ _source: { layers } }]),
    null,
  );
  if (parsed.ok) throw new Error("Expected a field-shape refusal");
  const failure = parsed.error.cause;
  expect(failure).toBeInstanceOf(ZodError);
  if (!(failure instanceof ZodError)) throw failure;
  expect(failure.issues).toEqual(
    expect.arrayContaining([expect.objectContaining(issue)]),
  );
});

it.each([
  [["2"], ["2"]],
  [["2"], ["1"]],
])("rejects repeated or reordered producer frames: %j then %j", (...frames) => {
  expect(
    parsePacketOutput(
      JSON.stringify(
        frames.map((frame) => ({
          _source: { layers: { "frame.number": frame } },
        })),
      ),
      null,
    ),
  ).toEqual({
    ok: false,
    error: { reason: "TShark returned unordered frames." },
  });
});

it("preserves canonical field names emitted for a selected alias", () => {
  const output = JSON.stringify([
    {
      _source: {
        layers: { "frame.number": ["1"], "dhcp.type": ["1"] },
      },
    },
  ]);
  expect(parsePacketOutput(output, null)).toEqual({
    ok: true,
    value: [{ "frame.number": ["1"], "dhcp.type": ["1"] }],
  });
});

it("validates every frame against the input read limit while allowing filtered gaps", () => {
  const output = JSON.stringify(
    [2, 7].map((frame) => ({
      _source: { layers: { "frame.number": [String(frame)] } },
    })),
  );
  expect(parsePacketOutput(output, 7)).toMatchObject({
    ok: true,
    value: { length: 2 },
  });
  expect(parsePacketOutput(output, 6)).toEqual({
    ok: false,
    error: {
      reason: "TShark returned a frame beyond the selected input packet limit.",
    },
  });
  expect(parsePacketOutput(output, null)).toMatchObject({
    ok: true,
    value: { length: 2 },
  });
});

it.each([
  [
    "truncated JSON",
    '[{"_source":{"layers":',
    "TShark emitted malformed JSON.",
  ],
  ["a non-array root", "{}", "TShark packet root must be an array."],
  [
    "a packet without layers",
    '[{"_source":{}}]',
    "TShark packet 1 lacks _source.layers.",
  ],
])("refuses %s with a reason", (_label, output, reason) => {
  expect(parsePacketOutput(output, null)).toMatchObject({
    ok: false,
    error: { reason },
  });
});
