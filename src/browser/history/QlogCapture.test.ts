import { expect, it } from "vitest";
import { decodeQlogCapture } from "./QlogCapture.js";
import { decodeCaptureText } from "./CaptureJson.js";
import { CaptureFormatError } from "./CaptureFormatError.js";

// Synthetic format inputs exercise distinct parser semantics, not producer provenance.
const event = (frames: unknown[], name = "transport:packet_sent") => ({
  name,
  time: 1791819895000.25,
  data: { header: { packet_type: "1RTT", packet_number: 5 }, frames },
});
const frame = (offset: number, length: number, fin = false) => ({
  frame_type: "stream",
  stream_id: 0,
  offset,
  length,
  fin,
});
const capture = (events: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    qlog_format: "JSON",
    qlog_version: "0.3",
    ...extra,
    traces: [
      {
        common_fields: { ODCID: "same" },
        vantage_point: { name: "aioquic", type: "server" },
        events,
      },
    ],
  });
const facts = (text: string, sensitive: string[] = []) => {
  const decoded = decodeQlogCapture(text, sensitive);
  if (!("qlog" in decoded)) throw new Error("qlog facet required");
  return { decoded, traces: decoded.qlog.traces };
};

it("derives interval unions per trace/direction while retaining event source order and extensions", () => {
  const original = JSON.parse(
    capture([
      event([frame(10, 10)]),
      event([frame(0, 15), frame(30, 5, true)]),
      event([frame(0, 4)], "transport:packet_received"),
      {
        name: "recovery:packet_lost",
        time: 1,
        data: { packet_number: 5, type: "1RTT" },
      },
    ]),
  );
  original.traces.push({
    ...original.traces[0],
    events: [event([frame(0, 3)])],
  });
  Object.defineProperty(original, "__proto__", {
    enumerable: true,
    value: { ordinary: true },
  });
  original.extra = "https://example.test/path?token=ordinary";
  const { decoded, traces } = facts(JSON.stringify(original));
  expect(traces[0]?.streams[0]).toMatchObject({
    stream_id: "0",
    direction: "sent",
    unique_bytes: "25",
    frame_length_sum: "30",
    repeated_bytes: "5",
    covered_ranges: [
      { start: "0", end: "20" },
      { start: "30", end: "35" },
    ],
    reported_final_sizes: ["35"],
  });
  expect(traces[0]?.streams[1]).toMatchObject({
    direction: "received",
    unique_bytes: "4",
  });
  expect(traces[1]?.streams[0]).toMatchObject({ unique_bytes: "3" });
  expect(traces[0]?.loss_declarations[0]).toMatchObject({
    confidence: "observed",
    packet_number: { state: "reported", value: "5" },
    packet_number_space: "application",
  });
  expect(decoded.records.at(-1)?.location).toEqual({
    kind: "json-pointer",
    pointer: "/traces/1/events/0",
  });
  expect(decoded.container.reported).toMatchObject({
    extra: original.extra,
    ["__proto__"]: { ordinary: true },
  });
  expect(Reflect.get(Object.prototype, "ordinary")).toBeUndefined();
});

it("keeps exact 62-bit integers and numeric lexemes without allocating exponent expansion", () => {
  const text = capture([event([frame(0, 0, true)])])
    .replace('"stream_id":0', '"stream_id":4611686018427387903')
    .replace('"offset":0', '"offset":9007199254740993')
    .replace('"length":0', '"length":1e3');
  const { decoded, traces } = facts(text);
  expect(traces[0]?.streams[0]).toMatchObject({
    stream_id: "4611686018427387903",
    unique_bytes: "1000",
    reported_final_sizes: ["9007199254741993"],
  });
  expect(decoded.records[0]?.numeric_literals).toContainEqual({
    pointer: "/data/frames/0/length",
    producer_type: "json-number",
    literal: "1e3",
  });
  expect(decoded.records[0]?.reported).toMatchObject({
    data: { frames: [{ stream_id: null, offset: null, length: 1000 }] },
  });
});

it("keeps incomplete fields unknown and FIN without bytes as metadata", () => {
  const { traces } = facts(
    capture([
      event([{ frame_type: "stream", stream_id: 0, length: 5 }]),
      event([frame(10, 0, true)]),
      { name: "recovery:packet_lost", time: 1, data: {} },
      {
        name: "extension:custom",
        time: 0,
        data: { body: "ordinary evidence" },
      },
    ]),
  );
  expect(traces[0]?.incomplete_fact_records).toEqual([0]);
  expect(traces[0]?.streams[0]).toMatchObject({
    unique_bytes: "0",
    covered_ranges: [],
    reported_final_sizes: ["10"],
  });
  expect(traces[0]?.loss_declarations[0]?.packet_number.state).toBe("unknown");
});

it("excludes structural auth material and explicit normalized values without guessing extension secrecy", () => {
  const text = capture([
    {
      name: "http:frame_parsed",
      time: 1,
      data: {
        frame: {
          frame_type: "headers",
          headers: [
            { name: "authorization", value: "Bearer credential" },
            { name: ":path", value: "/?token=ordinary" },
            { name: "location", value: "https://user:pass@example.test/a" },
          ],
        },
      },
    },
    {
      name: "transport:parameters_set",
      time: 2,
      data: { stateless_reset_token: "reset-credential" },
    },
    event([
      { frame_type: "new_connection_id", reset_token: "reset-frame" },
      { frame_type: "new_token", token: "new-token" },
      frame(0, 100),
    ]),
    {
      name: "extension:custom",
      time: 3,
      data: {
        secret: "caller-selected ordinary value",
        reset_token: "extension ordinary",
      },
    },
  ]).replace('"length":100', '"length":1e2');
  const { decoded, traces } = facts(text, ["100"]);
  const serialized = JSON.stringify(decoded);
  for (const hidden of [
    "Bearer credential",
    "reset-credential",
    "reset-frame",
    "new-token",
    "100",
    "user:pass",
  ])
    expect(serialized).not.toContain(hidden);
  expect(serialized).toContain("token=ordinary");
  expect(serialized).toContain("caller-selected ordinary value");
  expect(traces[0]?.streams).toEqual([]);
  expect(traces[0]?.incomplete_fact_records).toContain(2);
});

it("hides marked ancestor keys and safe derived sums while still validating hidden subtrees", () => {
  const text = capture([event([frame(0, 3), frame(3, 4)])]);
  expect(facts(text, ["7"]).traces[0]?.streams).toEqual([]);
  const { decoded, traces } = facts(text, ["events"]);
  expect(decoded.records[0]?.reported).toBe(null);
  expect(decoded.records[0]?.location.kind).toBe("unknown");
  expect(traces[0]?.location.kind).toBe("unknown");
  expect(traces[0]?.streams).toEqual([]);
  expect(() =>
    facts(text.replace('"length":3', '"length":-3'), ["events"]),
  ).toThrow(CaptureFormatError);
});

it.each([
  "-1",
  "0.5",
  "4611686018427387904",
  "1e1000000",
  "1e-1000000",
  '"3"',
  "true",
])("rejects malformed or out-of-range STREAM integer %s", (literal) => {
  expect(() =>
    facts(
      capture([event([frame(0, 3)])]).replace(
        '"length":3',
        `"length":${literal}`,
      ),
    ),
  ).toThrow(CaptureFormatError);
});

it.each([
  '{"qlog_format":"JSON","qlog_format":"JSON","qlog_version":"0.3","traces":[]}',
  capture([]).slice(0, -1),
  capture([]) + " {}",
  capture([{ name: "invalid", time: "1", data: {} }]),
  capture([[1, "transport", "packet_sent", {}]]),
  capture([event([{ ...frame(0, 1), fin: "true" }])]),
  capture([event([{ ...frame(0, 1), offset: 4611686018427388000 }])]),
])(
  "rejects malformed JSON/profile events with no partial success: %s",
  (text) => {
    expect(() => facts(text)).toThrow(CaptureFormatError);
  },
);

it("rejects other qlog containers/versions and excessive nesting, accepts empty profiles and UTF-8 BOM", () => {
  for (const extra of [{ qlog_format: "JSON-SEQ" }, { qlog_version: "0.4" }])
    expect(() => facts(capture([], extra))).toThrow("Only the aioquic");
  expect(() =>
    facts(
      capture([], {
        extension: JSON.parse("[".repeat(65) + "0" + "]".repeat(65)),
      }),
    ),
  ).toThrow("nesting budget");
  expect(
    facts('{"qlog_format":"JSON","qlog_version":"0.3","traces":[]}').traces,
  ).toEqual([]);
  const raw = Buffer.from(capture([]));
  expect(
    facts(
      decodeCaptureText(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]),
        "qlog",
      ),
    ).decoded.total_records,
  ).toBe(0);
  expect(() => decodeCaptureText(Buffer.from([0xff]), "qlog")).toThrow("UTF-8");
});
