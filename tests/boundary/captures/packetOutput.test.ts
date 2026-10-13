import { expect, it } from "vitest";
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
  expect(parsePacketOutput(output, ["ip.addr"])).toEqual([
    { "frame.number": ["2"], "ip.addr": ["192.0.2.1", "192.0.2.2"] },
    { "frame.number": ["7"] },
  ]);
});

it.each(
  [
    [{ "ip.addr": ["192.0.2.1"] }],
    [{ "frame.number": ["1"], "ip.addr": "192.0.2.1" }],
    [{ "frame.number": ["0"] }],
    [{ "frame.number": ["1", "2"] }],
    [{ "frame.number": ["1"], "unselected.field": ["hidden"] }],
    [{ "frame.number": ["2"] }, { "frame.number": ["2"] }],
    [{ "frame.number": ["2"] }, { "frame.number": ["1"] }],
  ].map((layers) => [layers]),
)("rejects malformed, repeated or reordered producer frames: %j", (layers) => {
  expect(() =>
    parsePacketOutput(
      JSON.stringify(layers.map((value) => ({ _source: { layers: value } }))),
      ["ip.addr"],
    ),
  ).toThrow();
});
