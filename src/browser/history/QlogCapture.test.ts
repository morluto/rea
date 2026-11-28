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
  Object.defineProperty(original.traces[0].events[0].data, "__proto__", {
    enumerable: true,
    value: { eventExtension: "kept" },
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
  const container = decoded.container.reported;
  expect(Object.hasOwn(Object(container), "__proto__")).toBe(true);
  expect(decoded.records[0]?.reported).toMatchObject({
    data: { ["__proto__"]: { eventExtension: "kept" } },
  });
  expect(Reflect.get(Object.prototype, "ordinary")).toBeUndefined();
});

it("keeps exact 62-bit integers and source numeric lexemes", () => {
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

it("keeps incomplete STREAM facts, distinct FIN values and zero-byte final sizes", () => {
  const { decoded, traces } = facts(
    capture([
      event([{ ...frame(8, 3), fin: undefined }]),
      event([{ ...frame(8, 3), fin: null }]),
      event([frame(8, 3, false)]),
      event([{ ...frame(12, 0, true), stream_id: 6 }]),
      event([{ frame_type: "stream", stream_id: 0, length: 5 }]),
      { name: "recovery:packet_lost", time: 1, data: {} },
    ]),
  );
  expect(traces[0]).toMatchObject({
    incomplete_fact_records: [0, 1, 4],
    streams: [
      {
        stream_id: "0",
        unique_bytes: "3",
        covered_ranges: [{ start: "8", end: "11" }],
        reported_final_sizes: [],
      },
      {
        stream_id: "6",
        unique_bytes: "0",
        covered_ranges: [],
        reported_final_sizes: ["12"],
      },
    ],
    loss_declarations: [
      { record_ordinal: 5, packet_number: { state: "unknown" } },
    ],
  });
  expect(
    traces[0]?.streams.flatMap(({ contributions }) =>
      contributions.map(
        ({ record_ordinal, frame_index, offset, length, fin }) => [
          record_ordinal,
          frame_index,
          offset,
          length,
          fin,
        ],
      ),
    ),
  ).toEqual([
    [0, 0, "8", "3", null],
    [1, 0, "8", "3", null],
    [2, 0, "8", "3", false],
    [3, 0, "12", "0", true],
  ]);
  expect(decoded.records[0]?.reported).not.toHaveProperty("data.frames.0.fin");
  expect(decoded.records[1]?.reported).toHaveProperty(
    "data.frames.0.fin",
    null,
  );
});

it("marks non-string frame types incomplete without hiding their recorded values", () => {
  const { decoded, traces } = facts(
    capture([
      event([{ frame_type: 0 }, frame(0, 5)]),
      event([{ frame_type: false }], "transport:packet_received"),
      event([{ frame_type: "extension:custom" }]),
    ]),
  );
  expect(traces[0]?.incomplete_fact_records).toEqual([0, 1]);
  expect(traces[0]?.streams[0]?.unique_bytes).toBe("5");
  expect(decoded.records[0]?.reported).toMatchObject({
    data: { frames: [{ frame_type: 0 }, frame(0, 5)] },
  });
});

it("excludes structural QUIC credentials and marked normalized stream values", () => {
  const text = capture([
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
      data: { reset_token: "ordinary extension value" },
    },
  ]).replace('"length":100', '"length":1e2');
  const { decoded, traces } = facts(text, ["100"]);
  for (const excluded of [
    "reset-credential",
    "reset-frame",
    "new-token",
    "100",
  ])
    expect(JSON.stringify(decoded)).not.toContain(excluded);
  expect(decoded.records[0]?.reported).toHaveProperty(
    "data.stateless_reset_token",
    null,
  );
  expect(decoded.records[1]?.reported).toMatchObject({
    data: {
      frames: [
        { frame_type: "new_connection_id", reset_token: null },
        { frame_type: "new_token", token: null },
        { frame_type: "stream", length: null },
      ],
    },
  });
  expect(decoded.records[2]?.reported).toHaveProperty(
    "data.reset_token",
    "ordinary extension value",
  );
  expect(traces[0]?.streams).toEqual([]);
  expect(traces[0]?.incomplete_fact_records).toEqual([1]);
});

it("applies transport redaction only to actual HTTP header events", () => {
  const headers = [
    { name: "Authorization", value: "authorization credential" },
    { name: "Proxy-AUTHORIZATION", value: "proxy credential" },
    { name: "CoOkIe", value: "cookie credential" },
    { name: "Set-Cookie", value: "response cookie credential" },
    { name: "Location", value: "https://user:pass@example.test/path" },
    { name: ":path", value: "/?token=ordinary" },
    { name: "authorization-extra", value: "ordinary extension" },
  ];
  const names = ["http:frame_created", "extension:custom", "http:frame_parsed"];
  const { decoded } = facts(
    capture(
      names.map((name) => ({ name, time: 1, data: { frame: { headers } } })),
    ),
  );
  const redactedHeaders = headers.map((header, index) => ({
    ...header,
    value:
      index < 4
        ? null
        : index === 4
          ? "https://example.test/path"
          : header.value,
  }));
  const redactions = Array.from({ length: 5 }, (_, index) => ({
    pointer: `/data/frame/headers/${index}/value`,
    reason: "transport-credential",
  }));
  expect(decoded.records).toMatchObject([
    { reported: { data: { frame: { headers: redactedHeaders } } }, redactions },
    { reported: { data: { frame: { headers } } }, redactions: [] },
    { reported: { data: { frame: { headers: redactedHeaders } } }, redactions },
  ]);
});

it.each([
  { literal: "1e2", sensitive: "100", reported: null, retained: false },
  { literal: "1e2", sensitive: "1e2", reported: null, retained: false },
  { literal: "1e2", sensitive: "unrelated", reported: 100, retained: true },
  {
    literal: "9007199254740993",
    sensitive: "9007199254740993",
    reported: null,
    retained: false,
  },
  {
    literal: "9007199254740993",
    sensitive: "9007199254740992",
    reported: null,
    retained: true,
  },
])(
  "preserves numeric source spelling or excludes declared values: $literal / $sensitive",
  ({ literal, sensitive, reported, retained }) => {
    const text = capture([
      { name: "extension:custom", time: 1, data: { value: 123456789 } },
    ]).replace('"value":123456789', `"value":${literal}`);
    const { decoded } = facts(text, [sensitive]);
    expect(decoded.records[0]?.reported).toMatchObject({
      data: { value: reported },
    });
    expect(
      decoded.records[0]?.numeric_literals.filter(
        ({ pointer }) => pointer === "/data/value",
      ),
    ).toEqual(
      retained
        ? [{ pointer: "/data/value", producer_type: "json-number", literal }]
        : [],
    );
    expect(decoded.records[0]?.redactions).toEqual(
      retained
        ? []
        : [{ pointer: "/data/value", reason: "explicit-sensitive-value" }],
    );
  },
);

it.each([
  { hidden: "sent", incomplete: [0], streams: 0, losses: 1 },
  { hidden: "lost", incomplete: [1], streams: 1, losses: 0 },
  { hidden: "name", incomplete: [0, 1], streams: 0, losses: 0 },
])(
  "lists records whose event name a declaration of $hidden hides as incomplete",
  ({ hidden, incomplete, streams, losses }) => {
    const { traces } = facts(
      capture([
        event([frame(0, 10, true)]),
        {
          name: "recovery:packet_lost",
          time: 1,
          data: { packet_number: 5, type: "1RTT" },
        },
        { name: "extension:custom", time: 2, data: { body: "ordinary" } },
      ]),
      [hidden],
    );
    expect(traces[0]?.incomplete_fact_records).toEqual(incomplete);
    expect(traces[0]?.streams).toHaveLength(streams);
    expect(traces[0]?.loss_declarations).toHaveLength(losses);
  },
);

it("counts hidden payloads only for events interpreted as transport facts", () => {
  const text = capture([
    { name: "extension:custom", time: 0, data: { body: "ordinary" } },
    event([frame(0, 10, false)]),
    { name: "recovery:packet_lost", time: 2, data: { packet_number: 5 } },
  ]);
  const control = facts(text);
  expect(control.traces[0]?.incomplete_fact_records).toEqual([]);
  const hidden = facts(text, ["data"]);
  expect(hidden.traces[0]?.incomplete_fact_records).toEqual([1, 2]);
  expect(hidden.decoded.records.map((record) => record.reported)).toEqual([
    { name: "extension:custom", time: 0 },
    { name: "transport:packet_sent", time: 1791819895000.25 },
    { name: "recovery:packet_lost", time: 2 },
  ]);
});

it("omits a hidden derived total for a stream with more contributions than call arguments allow", () => {
  const events = Array.from({ length: 130 }, () =>
    event(Array.from({ length: 1_000 }, () => frame(0, 1))),
  );
  const { traces } = facts(capture(events), ["130000"]);
  expect(traces[0]?.streams).toEqual([]);
  expect(traces[0]?.incomplete_fact_records).toEqual(
    Array.from({ length: 130 }, (_, ordinal) => ordinal),
  );
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
  ).toThrow(
    expect.objectContaining({
      pointer: "/traces/0/events/0/data/frames/0/length",
      failure: expect.objectContaining({ kind: "malformed" }),
    }),
  );
});

it("rejects a STREAM whose valid offset and length exceed the range when added", () => {
  const text = capture([event([frame(0, 1)])]).replace(
    '"offset":0',
    '"offset":4611686018427387903',
  );
  expect(() => facts(text)).toThrow(
    expect.objectContaining({
      pointer: "/traces/0/events/0/data/frames/0",
      failure: expect.objectContaining({ kind: "malformed" }),
    }),
  );
});

it.each([
  '{"qlog_format":"JSON","qlog_format":"JSON","qlog_version":"0.3","traces":[]}',
  capture([]) + " {}",
  capture([{ name: "invalid", time: "1", data: {} }]),
  capture([[1, "transport", "packet_sent", {}]]),
  capture([event([{ ...frame(0, 1), fin: "true" }])]),
])(
  "rejects malformed JSON/profile events with no partial success: %s",
  (text) => {
    expect(() => facts(text)).toThrow(CaptureFormatError);
  },
);

it("retains an extension at the last admitted qlog container level", () => {
  // The root, traces array and trace object consume the first three levels.
  const nested = "[".repeat(61) + '"last-level"' + "]".repeat(61);
  const text = `{"qlog_format":"JSON","qlog_version":"0.3","traces":[{"events":[],"ext":${nested}}]}`;
  const bytes = Buffer.from("\ufeff" + text);
  const { decoded } = facts(decodeCaptureText(bytes, "qlog"));
  expect(decoded.container.reported).toHaveProperty(
    "traces.0.ext",
    JSON.parse(nested),
  );
});

it("distinguishes unsupported qlog sequences from an empty supported profile", () => {
  expect(() => facts(capture([], { qlog_format: "JSON-SEQ" }))).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({ kind: "unsupported" }),
    }),
  );
  expect(
    facts('{"qlog_format":"JSON","qlog_version":"0.3","traces":[]}').traces,
  ).toEqual([]);
});
