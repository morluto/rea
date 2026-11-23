import { expect, it } from "vitest";
import { ZodError } from "zod";
import { parsePacketOutput } from "../../../src/captures/parsePacketOutput.js";
import { DEFAULT_CAPTURE_PACKET_JSON_EXPANSION_BYTES } from "../../../src/domain/analysisResourceLimits.js";

const read = (
  output: string,
  packetLimit: number | null,
  expansionBytes = DEFAULT_CAPTURE_PACKET_JSON_EXPANSION_BYTES,
) =>
  parsePacketOutput(output, packetLimit, {
    outputBytes: Buffer.byteLength(output),
    expansionBytes,
  });

it("preserves repeated field values and missing fields while discarding export index metadata", async () => {
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
  expect(await read(output, 7)).toEqual({
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
])("rejects malformed producer fields: $layers", async ({ layers, issue }) => {
  const parsed = await read(JSON.stringify([{ _source: { layers } }]), null);
  if (parsed.ok || parsed.error.kind !== "output")
    throw new Error("Expected a field-shape refusal");
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
])(
  "rejects repeated or reordered producer frames: %j then %j",
  async (...frames) => {
    expect(
      await read(
        JSON.stringify(
          frames.map((frame) => ({
            _source: { layers: { "frame.number": frame } },
          })),
        ),
        null,
      ),
    ).toEqual({
      ok: false,
      error: { kind: "output", reason: "TShark returned unordered frames." },
    });
  },
);

it("preserves canonical field names emitted for a selected alias", async () => {
  const output = JSON.stringify([
    {
      _source: {
        layers: { "frame.number": ["1"], "dhcp.type": ["1"] },
      },
    },
  ]);
  expect(await read(output, null)).toEqual({
    ok: true,
    value: [{ "frame.number": ["1"], "dhcp.type": ["1"] }],
  });
});

it("validates every frame against the input read limit while allowing filtered gaps", async () => {
  const output = JSON.stringify(
    [2, 7].map((frame) => ({
      _source: { layers: { "frame.number": [String(frame)] } },
    })),
  );
  expect(await read(output, 7)).toMatchObject({
    ok: true,
    value: { length: 2 },
  });
  expect(await read(output, 6)).toEqual({
    ok: false,
    error: {
      kind: "output",
      reason: "TShark returned a frame beyond the selected input packet limit.",
    },
  });
  expect(await read(output, null)).toMatchObject({
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
])("refuses %s with a reason", async (_label, output, reason) => {
  expect(await read(output, null)).toMatchObject({
    ok: false,
    error: { reason },
  });
});

it("refuses output whose expansion estimate exceeds the selected budget", async () => {
  const output = JSON.stringify([
    { _source: { layers: { "frame.number": ["1"] } } },
  ]);
  expect(await read(output, null, 128)).toEqual({
    ok: false,
    error: { kind: "expansion" },
  });
  expect(await read(output, null, 64 * 1024)).toMatchObject({ ok: true });
});
