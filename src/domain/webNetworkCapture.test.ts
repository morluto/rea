import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  freezeJsonSnapshot,
  immutableJsonSnapshotMember,
} from "./immutableJson.js";
import {
  safeParseOwnedWebNetworkCapture,
  webNetworkCaptureSchema,
} from "./webNetworkCapture.js";

const capture = (format = "har") => ({
  format,
  artifact: { path: "/capture", sha256: "a".repeat(64), bytes: 10 },
  decoder: { id: "fixture", name: "Fixture", version: "1" },
  container: {
    reported: {},
    numeric_literals: [],
    redactions: [],
    records_pointer: "/log/entries",
  },
  total_records: 3,
  records: [
    {
      ordinal: 2,
      location: { kind: "json-pointer", pointer: "/log/entries/2" },
      reported: { method: "GET", timestamp: null },
      binary_fields: [],
      numeric_literals: [
        {
          pointer: "/time",
          producer_type: "json-number",
          literal: "9007199254740993",
        },
      ],
      redactions: [],
      limitations: [],
    },
  ],
  runtime_attribution: "unknown",
  limitations: [],
});

it.each(["har", "saz", "mitmproxy"])(
  "borrows a fully validated immutable %s capture, retaining exact source facts",
  (format) => {
    const source = freezeJsonSnapshot(capture(format));
    const expected = webNetworkCaptureSchema.parse(source);
    for (let page = 0; page < 2; page += 1) {
      const parsed = safeParseOwnedWebNetworkCapture(source);
      if (!parsed.success) throw parsed.error;
      expect(parsed.data).toBe(source);
      expect(parsed.data).toEqual(expected);
    }
  },
);

it.each(["mutable", "shallow-frozen"])(
  "revalidates a %s capture after a nested ordinal changes",
  (kind) => {
    const source = capture();
    if (kind === "shallow-frozen") Object.freeze(source);
    expect(safeParseOwnedWebNetworkCapture(source).success).toBe(true);
    source.records[0]!.ordinal = 3;
    expect(safeParseOwnedWebNetworkCapture(source)).toEqual(
      webNetworkCaptureSchema.safeParse(source),
    );
    expect(safeParseOwnedWebNetworkCapture(source).success).toBe(false);
    source.records[0]!.ordinal = 0;
    expect(safeParseOwnedWebNetworkCapture(source).success).toBe(true);
  },
);

it("validates a child of a sealed portable envelope and rejects malformed sealed siblings", () => {
  const malformed = capture();
  malformed.records.push({ ...malformed.records[0]! });
  const envelope = freezeJsonSnapshot({ valid: capture(), malformed });
  const valid = immutableJsonSnapshotMember(envelope, "valid");
  const parsed = safeParseOwnedWebNetworkCapture(valid);
  expect(parsed.success && parsed.data).toBe(valid);
  const invalid = immutableJsonSnapshotMember(envelope, "malformed");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = safeParseOwnedWebNetworkCapture(invalid);
    expect(result.success).toBe(false);
    expect(result).toEqual(webNetworkCaptureSchema.safeParse(invalid));
  }
});

it("does not treat external deep freezing as the owner's validation proof", () => {
  const source = capture();
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(source);
  for (let page = 0; page < 2; page += 1) {
    const parsed = safeParseOwnedWebNetworkCapture(source);
    if (!parsed.success) throw parsed.error;
    expect(parsed.data).not.toBe(source);
    expect(parsed.data).toEqual(webNetworkCaptureSchema.parse(source));
  }
});

it("retains schema normalization when an owned source contains a hidden reported field", () => {
  const source = capture();
  Object.defineProperty(source.container, "reported", {
    value: Object.defineProperty({}, "hidden", { value: 7 }),
    enumerable: true,
  });
  const sealed = freezeJsonSnapshot(source);
  const parsed = safeParseOwnedWebNetworkCapture(sealed);
  if (!parsed.success) throw parsed.error;
  expect(parsed.data).not.toBe(sealed);
  expect(parsed.data).toEqual(webNetworkCaptureSchema.parse(sealed));
  expect(
    Object.hasOwn(parsed.data.container.reported as object, "hidden"),
  ).toBe(false);
});

it.each([
  {
    name: "malformed base64",
    content_base64: "!!!!",
    bytes: 0,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  {
    name: "noncanonical pad bits",
    content_base64: "AR==",
    bytes: 1,
    sha256: createHash("sha256")
      .update(Buffer.from([1]))
      .digest("hex"),
  },
  {
    name: "mismatched byte count",
    content_base64: "YQ==",
    bytes: 2,
    sha256: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
  },
  {
    name: "mismatched digest",
    content_base64: "YQ==",
    bytes: 1,
    sha256: "0".repeat(64),
  },
])(
  "refuses $name in retained binary facts before projection",
  ({ name: _name, ...binary }) => {
    const report = capture();
    const record = {
      ...report.records[0]!,
      binary_fields: [
        {
          pointer: "/response/content/text",
          representation: "har-base64-content",
          state: "retained",
          ...binary,
        },
      ],
    };
    const parsed = webNetworkCaptureSchema.safeParse({
      ...report,
      records: [record],
    });
    expect(parsed.success).toBe(false);
  },
);

it.each([
  { name: "empty", bytes: Buffer.alloc(0) },
  { name: "Unicode", bytes: Buffer.from("雪�") },
  { name: "multiple windows", bytes: Buffer.alloc(100_001, 0xff) },
])(
  "retains $name canonical binary identity across bounded digest windows",
  ({ bytes }) => {
    const report = capture();
    const source = {
      ...report,
      records: [
        {
          ...report.records[0]!,
          binary_fields: [
            {
              pointer: "/body",
              representation: "producer-bytes",
              state: "retained",
              content_base64: bytes.toString("base64"),
              bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
          ],
        },
      ],
    };
    const parsed = webNetworkCaptureSchema.parse(source);
    expect(parsed).toEqual(source);
  },
);

it("refuses multiple binary declarations for one source coordinate", () => {
  const report = capture();
  const binary = (text: string) => ({
    pointer: "/response/content/text",
    representation: "har-base64-content",
    state: "retained",
    content_base64: Buffer.from(text).toString("base64"),
    bytes: Buffer.byteLength(text),
    sha256: createHash("sha256").update(text).digest("hex"),
  });
  expect(
    webNetworkCaptureSchema.safeParse({
      ...report,
      records: [
        {
          ...report.records[0]!,
          binary_fields: [binary("first"), binary("second")],
        },
      ],
    }).success,
  ).toBe(false);
});
