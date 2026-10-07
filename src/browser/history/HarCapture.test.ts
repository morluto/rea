import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { historicalHar } from "../../../tests/fixtures/historicalHar.js";
import { decodeHarCapture } from "./HarCapture.js";

it.each([
  { values: [] },
  { values: ["response"] },
  { values: ["content"] },
  { values: ["log"] },
  { values: ["entries"] },
])(
  "validates canonical base64 even when its parent property is sensitive: %j",
  ({ values }) => {
    const fixture = historicalHar();
    const first = fixture.log.entries[0];
    if (first === undefined) throw new Error("fixture missing");
    const input = {
      log: {
        ...fixture.log,
        entries: [
          {
            ...first,
            response: {
              ...first.response,
              content: {
                size: 1,
                mimeType: "application/octet-stream",
                encoding: "base64",
                text: "AR==",
              },
            },
          },
        ],
      },
    };
    expect(() => decodeHarCapture(JSON.stringify(input), values)).toThrow(
      "not valid canonical base64",
    );
  },
);

it.each(["log", "entries", "ntries"])(
  "excludes extracted record payloads beneath the marked structural property %s",
  (literal) => {
    const decoded = decodeHarCapture(JSON.stringify(historicalHar()), [
      literal,
    ]);
    expect(decoded.total_records).toBeGreaterThan(0);
    expect(decoded.container.records_pointer).toBe(null);
    for (const [ordinal, record] of decoded.records.entries()) {
      expect(record).toMatchObject({
        ordinal,
        location: { kind: "unknown", reason: "explicit-sensitive-value" },
        reported: null,
        binary_fields: [],
        numeric_literals: [],
        redactions: [{ pointer: "", reason: "explicit-sensitive-value" }],
      });
    }
  },
);

it("excludes sensitive property identities before emitting keys and sidecar coordinates", () => {
  const fixture = historicalHar();
  const first = fixture.log.entries[0];
  if (first === undefined) throw new Error("fixture missing");
  const result = decodeHarCapture(
    JSON.stringify({
      ...fixture,
      _extension: {
        "api-secret/~": { numeric: 123, text: "api-secret" },
        kept: 7,
      },
      log: { ...fixture.log, entries: [{ ...first, "api-secret": 42 }] },
    }),
    ["api-secret"],
  );
  expect(JSON.stringify(result)).not.toContain("api-secret");
  expect(result.container.reported).toMatchObject({ _extension: { kept: 7 } });
  expect(result.container.redactions).toContainEqual({
    pointer: "/_extension",
    reason: "explicit-sensitive-value",
    scope: "property-name",
  });
  expect(result.records[0]?.redactions).toContainEqual({
    pointer: "",
    reason: "explicit-sensitive-value",
    scope: "property-name",
  });
});

it.each([
  { value: "REDACTED", sensitive: ["REDACTED"] },
  { value: "literal[", sensitive: ["["] },
  { value: "before secret after", sensitive: ["secret", "REDACTED"] },
  { value: "before secret after", sensitive: ["secret", "[RED"] },
])(
  "excludes sensitive text without introducing replacement literals: $value",
  ({ value, sensitive }) => {
    const fixture = historicalHar();
    const result = decodeHarCapture(
      JSON.stringify({ ...fixture, _sensitive: value, _ordinary: "unmarked" }),
      sensitive,
    );
    expect(result.container.reported).toMatchObject({
      _sensitive: null,
      _ordinary: "unmarked",
    });
    expect(result.container.redactions).toContainEqual({
      pointer: "/_sensitive",
      reason: "explicit-sensitive-value",
    });
  },
);

it("excludes a declared literal introduced by stripping transport URL userinfo", () => {
  const fixture = historicalHar();
  const entry = fixture.log.entries[0];
  if (entry === undefined) throw new Error("fixture missing");
  const url = "https://example.test/sensitive";
  const input = {
    log: {
      ...fixture.log,
      entries: [
        {
          ...entry,
          request: {
            ...entry.request,
            url: "https://user:password@example.test/sensitive",
          },
        },
      ],
    },
  };
  const result = decodeHarCapture(JSON.stringify(input), [url]);
  expect(result.records[0]?.reported).toMatchObject({ request: { url: null } });
});

it.each([
  '"_duplicate":1,"_duplicate":1',
  '"_duplicate":null,"_duplicate":null',
  '"_duplicate":{"value":1},"_duplicate":{"value":1}',
  '"_duplicate":1,"\\u005fduplicate":1',
])(
  "rejects equal-valued duplicate JSON members before projection: %s",
  (members) => {
    const text = JSON.stringify(historicalHar()).replace(
      '"cache":{}',
      `"cache":{},${members}`,
    );
    expect(() => decodeHarCapture(text, [])).toThrow("duplicate");
  },
);

it("rejects identical duplicate core fields before schema validation", () => {
  const text = JSON.stringify(historicalHar()).replace(
    '"version":"1.2"',
    '"version":"1.2","version":"1.2"',
  );
  expect(() => decodeHarCapture(text, [])).toThrow("duplicate");
});

it("reports an unsupported JSON schema boundary instead of dropping a producer property", () => {
  const text = JSON.stringify(historicalHar()).replace(
    '"cache":{}',
    '"cache":{},"_extension":{"__proto__":{"preserved":7},"constructor":"ordinary"}',
  );
  expect(() => decodeHarCapture(text, [])).toThrow(
    "JSON schema boundary cannot preserve",
  );
});

it("preserves Unicode, offsets, sizes, duplicate URLs and opaque extensions without inventing bytes", () => {
  const fixture = historicalHar();
  const first = fixture.log.entries[0];
  if (first === undefined) throw new Error("fixture missing");
  fixture.log.entries.push(structuredClone(first));
  const result = decodeHarCapture(
    JSON.stringify({
      ...fixture,
      _extension: { isLosslessNumber: true, value: "ordinary" },
    }),
    [],
  );
  expect(result.total_records).toBe(2);
  expect(result.records[0]?.reported).toEqual(fixture.log.entries[0]);
  expect(result.records[0]?.binary_fields).toEqual([]);
  expect(result.records[0]?.numeric_literals).toContainEqual({
    pointer: "/response/bodySize",
    producer_type: "json-number",
    literal: "99",
  });
  expect(result.records[1]?.location).toEqual({
    kind: "json-pointer",
    pointer: "/log/entries/1",
  });
  expect(result.container.reported).toMatchObject({
    _extension: { isLosslessNumber: true, value: "ordinary" },
    log: { entries: null },
  });
});

it.each(["9007199254740993", "4740993", "99"])(
  "excludes explicitly sensitive numeric lexemes and their reported values: %s",
  (literal) => {
    const text = JSON.stringify(historicalHar()).replace(
      '"cache":{}',
      '"cache":{},"_big":9007199254740993',
    );
    const result = decodeHarCapture(text, [literal]);
    for (const record of result.records) {
      expect(
        record.numeric_literals.every(
          (number) => !number.literal.includes(literal),
        ),
      ).toBe(true);
    }
    const pointer = literal === "99" ? "/response/bodySize" : "/_big";
    expect(result.records[0]?.redactions).toContainEqual({
      pointer,
      reason: "explicit-sensitive-value",
    });
    if (literal === "99")
      expect(result.records[0]?.reported).toMatchObject({
        response: { bodySize: null },
      });
    else expect(result.records[0]?.reported).toMatchObject({ _big: null });
  },
);

it("keeps unsafe extension numeric lexemes and rejects unsafe mandatory schema numbers", () => {
  const text = JSON.stringify(historicalHar());
  const result = decodeHarCapture(
    text.replace('"cache":{}', '"cache":{},"_big":9007199254740993'),
    [],
  );
  expect(result.records[0]?.numeric_literals).toContainEqual({
    pointer: "/_big",
    producer_type: "json-number",
    literal: "9007199254740993",
  });
  expect(result.records[0]?.reported).toMatchObject({ _big: null });
  expect(() =>
    decodeHarCapture(
      text.replace('"bodySize":0', '"bodySize":9007199254740993'),
      [],
    ),
  ).toThrow("HAR schema validation failed");
});

it.each(["container", "record"] as const)(
  "retains %s extension content without interpreting it as an HTTP body",
  (location) => {
    const fixture = historicalHar();
    const extension = {
      response: { content: { encoding: "base64", text: "opaque extension" } },
    };
    const input =
      location === "container"
        ? { ...fixture, _extension: extension }
        : {
            log: {
              ...fixture.log,
              entries: fixture.log.entries.map((entry) => ({
                ...entry,
                _extension: extension,
              })),
            },
          };
    const result = decodeHarCapture(JSON.stringify(input), []);
    expect(
      location === "container"
        ? result.container.reported
        : result.records[0]?.reported,
    ).toMatchObject({ _extension: extension });
    expect(result.records[0]?.binary_fields).toEqual([]);
  },
);

it("retains valid base64 bytes independently of declared sizes", () => {
  const fixture = historicalHar();
  const entry = fixture.log.entries[0];
  if (entry === undefined) throw new Error("fixture missing");
  const text = JSON.stringify({
    log: {
      ...fixture.log,
      entries: [
        {
          ...entry,
          response: {
            ...entry.response,
            content: {
              size: 999,
              mimeType: "application/octet-stream",
              encoding: "base64",
              text: "AP9B\n",
            },
          },
        },
      ],
    },
  });
  const result = decodeHarCapture(text, []);
  expect(result.records[0]?.binary_fields[0]).toMatchObject({
    pointer: "/response/content/text",
    state: "retained",
    content_base64: "AP9B",
    bytes: 3,
  });
  expect(result.records[0]?.reported).toMatchObject({
    response: { content: { size: 999, text: "AP9B\n" } },
  });
  expect(() => decodeHarCapture(text.replace("AP9B", "AR=="), [])).toThrow(
    "not valid canonical base64",
  );
});

it("redacts actual authentication fields and explicit binary values while preserving similarly named extensions", () => {
  const fixture = historicalHar();
  const entry = fixture.log.entries[0];
  if (entry === undefined) throw new Error("fixture missing");
  const raw = {
    log: {
      ...fixture.log,
      entries: [
        {
          ...entry,
          request: {
            ...entry.request,
            url: "https://user:password@example.test/a?token=ordinary#fragment",
            headers: [
              { name: "Authorization", value: "Bearer transport-secret" },
              { name: "X-Test", value: "a" },
              { name: "X-Test", value: "b" },
            ],
            cookies: [{ name: "session", value: "cookie-secret" }],
          },
          response: {
            ...entry.response,
            content: {
              size: 5,
              mimeType: "application/octet-stream",
              encoding: "base64",
              text: Buffer.from("chosen-private").toString("base64"),
            },
          },
          _extension: {
            response: {
              headers: [{ name: "Authorization", value: "ordinary-extension" }],
            },
          },
        },
      ],
    },
  };
  const result = decodeHarCapture(JSON.stringify(raw), ["chosen-private"]);
  const output = JSON.stringify(result);
  for (const secret of [
    "password",
    "transport-secret",
    "cookie-secret",
    Buffer.from("chosen-private").toString("base64"),
  ])
    expect(output).not.toContain(secret);
  expect(output).toContain("token=ordinary#fragment");
  expect(output).toContain("ordinary-extension");
  expect(result.records[0]?.reported).toMatchObject({
    request: {
      headers: [
        { name: "Authorization", value: null },
        { name: "X-Test", value: "a" },
        { name: "X-Test", value: "b" },
      ],
    },
  });
  expect(result.records[0]?.binary_fields[0]).toMatchObject({
    state: "redacted",
    sha256: null,
    content_base64: null,
  });
});

it.each([
  "{",
  '{"log":{},"log":{}}',
  JSON.stringify({ log: { version: "1.2", entries: [] } }),
])("rejects malformed producer data %s", (text) => {
  expect(() => decodeHarCapture(text, [])).toThrow();
});

it("preserves observed SaveHar null post-data without broadening arbitrary HAR producers", () => {
  const fixture = historicalHar();
  const first = fixture.log.entries[0];
  if (first === undefined) throw new Error("fixture missing");
  const log = {
    ...fixture.log,
    creator: { name: "mitmproxy", version: "12.2.3" },
    entries: [
      {
        ...first,
        request: {
          ...first.request,
          postData: { mimeType: "text/plain", text: null },
        },
      },
    ],
  };
  expect(
    decodeHarCapture(JSON.stringify({ log }), []).records[0]?.reported,
  ).toMatchObject({ request: { postData: { text: null } } });
  expect(() =>
    decodeHarCapture(
      JSON.stringify({
        log: { ...log, creator: { name: "other", version: "1" } },
      }),
      [],
    ),
  ).toThrow("HAR schema validation failed");
});

it.each([
  "c2VjcmV0",
  "c2Vj",
  createHash("sha256").update("secret").digest("hex"),
])(
  "excludes sensitive derived byte representations from spaced HAR text: %s",
  (literal) => {
    const fixture = historicalHar();
    const first = fixture.log.entries[0];
    if (first === undefined) throw new Error("fixture missing");
    const result = decodeHarCapture(
      JSON.stringify({
        log: {
          ...fixture.log,
          entries: [
            {
              ...first,
              response: {
                ...first.response,
                content: {
                  size: 6,
                  mimeType: "application/octet-stream",
                  encoding: "base64",
                  text: "c2 VjcmV0",
                },
              },
            },
          ],
        },
      }),
      [literal],
    );
    expect(result.records[0]?.reported).toMatchObject({
      response: { content: { text: null } },
    });
    expect(result.records[0]?.binary_fields).toContainEqual({
      pointer: "/response/content/text",
      representation: "har-base64-content",
      state: "redacted",
      content_base64: null,
      bytes: null,
      sha256: null,
    });
  },
);

it("excludes a declared literal in encoded HAR text from its binary sidecar too", () => {
  const fixture = historicalHar();
  const first = fixture.log.entries[0];
  if (first === undefined) throw new Error("fixture missing");
  const log = {
    ...fixture.log,
    entries: [
      {
        ...first,
        response: {
          ...first.response,
          content: {
            size: 3,
            mimeType: "application/octet-stream",
            encoding: "base64",
            text: "AP9B",
          },
        },
      },
    ],
  };
  const result = decodeHarCapture(JSON.stringify({ log }), ["AP9B"]);
  expect(JSON.stringify(result)).not.toContain("AP9B");
  expect(result.records[0]?.binary_fields[0]?.state).toBe("redacted");
});

it("rejects excessive extension nesting instead of returning a partial capture", () => {
  let extension: unknown = null;
  for (let index = 0; index < 66; index++) extension = { child: extension };
  expect(() =>
    decodeHarCapture(
      JSON.stringify({ ...historicalHar(), _extension: extension }),
      [],
    ),
  ).toThrow("nesting budget");
});

it.each([
  { name: "Location", side: "response" as const },
  { name: "Referer", side: "request" as const },
  { name: "Origin", side: "request" as const },
])(
  "excludes leading-OWS userinfo from a producer $name header",
  ({ name, side }) => {
    const fixture = historicalHar();
    const first = fixture.log.entries[0];
    if (first === undefined) throw new Error("fixture missing");
    const value =
      " \tHTTPS://user:password@example.test/path?token=ordinary#fragment\t ";
    const result = decodeHarCapture(
      JSON.stringify({
        log: {
          ...fixture.log,
          entries: [
            {
              ...first,
              [side]: { ...first[side], headers: [{ name, value }] },
            },
          ],
        },
      }),
      [],
    );
    expect(result.records[0]?.reported).toMatchObject({
      [side]: {
        headers: [
          {
            name,
            value: " \tHTTPS://example.test/path?token=ordinary#fragment\t ",
          },
        ],
      },
    });
    expect(result.records[0]?.redactions).toContainEqual({
      pointer: `/${side}/headers/0/value`,
      reason: "transport-credential",
    });
  },
);
