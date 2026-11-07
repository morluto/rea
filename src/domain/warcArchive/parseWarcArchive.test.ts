import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseWarcArchive } from "./parseWarcArchive.js";
import type { WarcArchive } from "./warcArchive.js";

const artifact = {
  path: "/artifacts/crawl.warc",
  sha256: "a".repeat(64),
  bytes: 0,
};

const record = (
  type: string,
  fields: readonly (readonly [string, string])[],
  payload = "",
): string => {
  const headers = [
    "WARC/1.1",
    `WARC-Type: ${type}`,
    ...fields.map(([name, value]) => `${name}: ${value}`),
    `Content-Length: ${Buffer.byteLength(payload)}`,
    "",
    "",
  ].join("\r\n");
  return headers + payload;
};

const parse = (text: string | Buffer, options = {}) =>
  parseWarcArchive(
    Buffer.isBuffer(text) ? text : Buffer.from(text),
    {
      ...artifact,
      bytes: Buffer.isBuffer(text) ? text.length : Buffer.byteLength(text),
    },
    { maxRecords: 100, maxDecodedBytes: 1024 * 1024, ...options },
  );

const parsed = (text: string | Buffer, options = {}): WarcArchive => {
  const result = parse(text, options);
  if (!result.ok) throw new Error("expected a parsed archive");
  return result.value;
};

describe("parseWarcArchive", () => {
  it("inventories concatenated records in archive order", () => {
    const archive = parsed(
      record(
        "warcinfo",
        [["WARC-Record-ID", "<urn:uuid:1>"]],
        "software: rea\r\n",
      ) +
        record(
          "request",
          [["WARC-Target-URI", "https://example.test/a"]],
          "GET /a HTTP/1.1\r\n\r\n",
        ) +
        record(
          "response",
          [["WARC-Target-URI", "https://example.test/a"]],
          "HTTP/1.1 204 No Content\r\n\r\n",
        ),
    );
    expect(archive.records.map((entry) => entry.record_type)).toEqual([
      "warcinfo",
      "request",
      "response",
    ]);
    expect(archive.records.map((entry) => entry.ordinal)).toEqual([0, 1, 2]);
    expect(archive.summary).toMatchObject({
      records: 3,
      known_types: 3,
      unknown_types: 0,
      requests: 1,
      responses: 1,
    });
    expect(archive.source_coverage.status).toBe("complete-within-scope");
    expect(archive.diagnostics).toEqual([]);
  });

  it("keeps record offsets on the decoded stream and stays deterministic", () => {
    const text =
      record(
        "resource",
        [["WARC-Target-URI", "https://example.test/x"]],
        "body",
      ) +
      record(
        "resource",
        [["WARC-Target-URI", "https://example.test/y"]],
        "body",
      );
    const first = parsed(text);
    const second = parsed(text);
    expect(first).toEqual(second);
    expect(first.records[0]?.offset).toBe(0);
    expect(first.records[1]?.offset).toBeGreaterThan(0);
    expect(first.archive_id).toBe(second.archive_id);
  });

  it("decodes the embedded HTTP response header block without retaining the body", () => {
    const payload =
      "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\nmissing";
    const archive = parsed(
      record(
        "response",
        [["WARC-Target-URI", "https://example.test/a"]],
        payload,
      ),
    );
    const http = archive.records[0]?.http;
    expect(http).toMatchObject({
      start_line: "HTTP/1.1 404 Not Found",
      version: "1.1",
      method: null,
      request_target: null,
      status_code: 404,
      reason_phrase: "Not Found",
      header_bytes:
        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\n"
          .length,
      body_bytes: "missing".length,
      body_framing_declared: false,
    });
    // Repeats are kept in archive order rather than collapsed to one value.
    expect(http?.headers).toEqual([
      { name: "Content-Type", value: "text/plain" },
      { name: "Set-Cookie", value: "a=1" },
      { name: "Set-Cookie", value: "b=2" },
    ]);
    expect(archive.source_coverage).toMatchObject({
      scope: "record-headers-and-http-headers",
      payloads: "header-block-only",
      http_headers: "decoded",
      http_bodies: "not-decoded",
    });
    expect(archive.summary.http_messages).toBe(1);
    expect(archive.diagnostics).toEqual([]);
  });

  it("lists unknown record types instead of dropping them", () => {
    const archive = parsed(record("vendor-extension", [], "opaque"));
    expect(archive.records[0]).toMatchObject({
      record_type: "vendor-extension",
      record_type_known: false,
    });
    expect(archive.summary.unknown_types).toBe(1);
  });

  it("decodes concatenated gzip members", () => {
    const bytes = Buffer.concat([
      gzipSync(
        Buffer.from(
          record(
            "request",
            [["WARC-Target-URI", "https://example.test/1"]],
            "",
          ),
        ),
      ),
      gzipSync(
        Buffer.from(
          record(
            "response",
            [["WARC-Target-URI", "https://example.test/1"]],
            "HTTP/1.1 200 OK\r\n\r\n",
          ),
        ),
      ),
    ]);
    const archive = parsed(bytes);
    expect(archive.compression).toBe("gzip");
    expect(archive.summary).toMatchObject({ requests: 1, responses: 1 });
    expect(archive.records[1]?.http?.status_code).toBe(200);
  });

  it("stops at max_decoded_bytes instead of inflating further", () => {
    const archive = parsed(gzipSync(Buffer.alloc(64 * 1024, 0x41)), {
      maxDecodedBytes: 1024,
    });
    expect(archive.compression).toBe("unsupported");
    expect(archive.diagnostics.map((entry) => entry.code)).toEqual([
      "decoded-size-limit-reached",
    ]);
    expect(archive.source_coverage.status).toBe("partial");
  });

  it("reports non-gzip non-WARC input as not a stream", () => {
    const archive = parsed("PK\u0003\u0004not an archive");
    expect(archive.compression).toBe("identity");
    expect(archive.diagnostics[0]?.code).toBe("not-a-warc-stream");
    expect(archive.records).toEqual([]);
  });
});

describe("malformed and bounded archives", () => {
  it("isolates a truncated record and keeps the records before it", () => {
    const complete = record(
      "request",
      [["WARC-Target-URI", "https://example.test/a"]],
      "",
    );
    const truncated = record(
      "response",
      [["WARC-Target-URI", "https://example.test/a"]],
      "HTTP/1.1 200 OK\r\n\r\nbody",
    ).slice(0, -4);
    const archive = parsed(complete + truncated);
    expect(archive.records).toHaveLength(2);
    expect(archive.records[1]?.payload_bytes).toBeLessThan(
      archive.records[1]?.content_length ?? 0,
    );
    expect(archive.diagnostics.map((entry) => entry.code)).toContain(
      "truncated-record",
    );
    expect(archive.source_coverage.status).toBe("partial");
  });

  it("reports an invalid Content-Length without inventing an extent", () => {
    const archive = parsed(
      "WARC/1.1\r\nWARC-Type: resource\r\nContent-Length: not-a-number\r\n\r\npayload",
    );
    expect(archive.records).toHaveLength(1);
    expect(archive.records[0]?.content_length).toBeNull();
    expect(archive.diagnostics.map((entry) => entry.code)).toContain(
      "invalid-content-length",
    );
  });

  it("keeps the first value of a repeated header and reports the repeat", () => {
    const archive = parsed(
      "WARC/1.1\r\nWARC-Type: resource\r\nWARC-Type: response\r\nContent-Length: 0\r\n\r\n",
    );
    expect(archive.records[0]?.record_type).toBe("resource");
    expect(archive.records[0]?.malformed_header_lines).toEqual([
      "WARC-Type: response",
    ]);
    expect(archive.summary.malformed_headers).toBe(1);
  });

  it("accepts a repeatable field repeated many times without reporting it", () => {
    const repeats = 20_000;
    const archive = parsed(
      "WARC/1.1\r\nWARC-Type: resource\r\n" +
        Array.from(
          { length: repeats },
          (_, i) => `WARC-Protocol: p${i}\r\n`,
        ).join("") +
        "Content-Length: 0\r\n\r\n",
    );
    // A repeatable field is valid however often it appears; only non-repeatable
    // ones are defects. The first value stays authoritative.
    expect(archive.records[0]?.malformed_header_lines).toEqual([]);
    expect(archive.summary.malformed_headers).toBe(0);
    expect(archive.records[0]?.record_type).toBe("resource");
  });

  it("reports header lines that are not fields", () => {
    const archive = parsed(
      "WARC/1.1\r\nWARC-Type: resource\r\nnot a header\r\nContent-Length: 0\r\n\r\n",
    );
    expect(archive.records[0]?.malformed_header_lines).toEqual([
      "not a header",
    ]);
    expect(archive.diagnostics.map((entry) => entry.code)).toContain(
      "invalid-header-line",
    );
  });

  it("stops at max_records and says so", () => {
    const text =
      record("resource", [], "a") +
      record("resource", [], "b") +
      record("resource", [], "c");
    const archive = parsed(text, { maxRecords: 2 });
    expect(archive.records).toHaveLength(2);
    expect(archive.diagnostics.map((entry) => entry.code)).toEqual([
      "record-limit-reached",
    ]);
    expect(archive.source_coverage.status).toBe("partial");
  });

  it("accepts an empty archive as an empty inventory", () => {
    const archive = parsed("");
    expect(archive.records).toEqual([]);
    expect(archive.summary.records).toBe(0);
  });

  it("preserves revisit records as records, not resolved responses", () => {
    const archive = parsed(
      record(
        "revisit",
        [
          [
            "WARC-Profile",
            "http://netpreserve.org/warc/1.1/revisit/identical-payload-digest",
          ],
        ],
        "",
      ),
    );
    expect(archive.records[0]?.record_type).toBe("revisit");
    expect(archive.records[0]?.profile).toContain("revisit");
    expect(archive.records[0]?.http).toBeNull();
    expect(archive.source_coverage.related_records).toBe("not-linked");
  });

  it("does not report a record's own CRLF separator as trailing bytes", () => {
    // Two records joined by the CRLF pair one record already ends with. Searching
    // from the separator matched the next record's `WARC/` only after the gap,
    // and the separator itself was then reported as stray bytes, so an intact
    // archive came back `partial`.
    const archive = parsed(
      record("response", [
        ["WARC-Record-ID", "<urn:1>"],
        ["WARC-Target-URI", "http://example.test/WARC/1.1"],
      ]) +
        "\r\n" +
        record("response", [["WARC-Record-ID", "<urn:2>"]]),
    );
    expect(archive.diagnostics).toEqual([]);
    expect(archive.records).toHaveLength(2);
    expect(archive.source_coverage.status).toBe("complete-within-scope");
  });

  it("still reports bytes after the separator as trailing", () => {
    const archive = parsed(
      record("response", [["WARC-Record-ID", "<urn:1>"]]) + "junk",
    );
    expect(archive.diagnostics.map((d) => d.code)).toEqual(["trailing-bytes"]);
    expect(archive.source_coverage.status).toBe("partial");
  });

  it("accepts a field WARC defines as repeatable", () => {
    // WARC permits these to repeat; rejecting every repeat put valid archives
    // into `partial` with invalid-header-line diagnostics.
    const archive = parsed(
      record("response", [
        ["WARC-Record-ID", "<urn:1>"],
        ["WARC-Concurrent-To", "<urn:2>"],
        ["WARC-Concurrent-To", "<urn:3>"],
        ["WARC-Protocol", "http/1.1"],
        ["WARC-Protocol", "ipfs"],
      ]),
    );
    expect(
      archive.diagnostics.filter((d) => d.code === "invalid-header-line"),
    ).toEqual([]);
    expect(archive.source_coverage.status).toBe("complete-within-scope");
  });

  it("reports a repeated single-value field as malformed", () => {
    const archive = parsed(
      record("response", [
        ["WARC-Type", "response"],
        ["Content-Type", "application/http"],
      ]),
    );
    expect(archive.diagnostics.map((d) => d.code)).toContain(
      "invalid-header-line",
    );
  });
});

describe("field validation", () => {
  it("reports a field name that is not a header token", () => {
    // "Bad Name: value" passed the old colon-only check, so the field was
    // dropped without any diagnostic reaching the report.
    const archive = parsed(
      "WARC/1.1\r\nWARC-Type: response\r\nBad Name: value\r\nContent-Length: 0\r\n\r\n\r\n",
    );
    expect(archive.diagnostics.map((d) => d.code)).toContain(
      "invalid-header-line",
    );
    expect(archive.summary.malformed_headers).toBeGreaterThan(0);
  });

  it("bounds rejected version lines that never produce a record", () => {
    // These reach `continue`, so max_records never stops them; a small gzip
    // can carry millions and the whole scan runs synchronously. The genuine
    // record past the ceiling proves the scan stopped rather than merely
    // reporting: the diagnostic itself can be masked by the 10000-diagnostic
    // ceiling, which these lines fill on their own.
    const junk = "WARC/not-a-version\r\n\r\n".repeat(10_001);
    const archive = parsed(
      junk + record("response", [["WARC-Record-ID", "<urn:late>"]], "late"),
      { maxRecords: 100 },
    );
    expect(archive.records).toHaveLength(0);
    expect(archive.source_coverage.status).toBe("partial");
  });

  it("rejects a version line without a version instead of inventing a record", () => {
    // Any line starting `WARC/` used to be a record, so this passed as a clean
    // inventory and its declared length could consume the real record after it.
    const junk =
      "WARC/not-a-version\r\nWARC-Type: resource\r\nContent-Length: 0\r\n\r\n";
    const archive = parsed(
      junk + record("response", [["WARC-Record-ID", "<urn:real>"]], "real"),
    );
    expect(archive.records.map((r) => r.record_type)).toEqual(["response"]);
    expect(archive.diagnostics.map((d) => d.code)).toContain(
      "invalid-version-line",
    );
    expect(archive.source_coverage.status).toBe("partial");
  });

  it("still accepts a version line carrying a trailing comment", () => {
    const archive = parsed(
      "WARC/1.1 written by a crawler\r\nWARC-Type: resource\r\nContent-Length: 0\r\n\r\n\r\n",
    );
    expect(archive.records).toHaveLength(1);
    expect(archive.diagnostics).toEqual([]);
  });
});

describe("response status line", () => {
  it("rejects a malformed status line without scanning it quadratically", () => {
    // `\s+` and `.*` rescanned the same spaces, so this took ~1.4 s at 32,000
    // blanks — synchronously, blocking the server and its cancellation.
    const spaced = `HTTP/1.1 200 ${" ".repeat(200_000)}A\rX\r\n\r\n`;
    const started = Date.now();
    const archive = parsed(
      record("response", [["WARC-Record-ID", "<urn:1>"]], spaced),
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(archive.records[0]?.http).toBeNull();
  });

  it("bounds the start line before decoding it", () => {
    const padded = `HTTP/1.1 200${" ".repeat(9000)}ok\r\n\r\n`;
    const archive = parsed(
      record("response", [["WARC-Record-ID", "<urn:1>"]], padded),
    );
    expect(archive.records[0]?.http).toBeNull();
    // `http: null` alone cannot tell this apart from a body, so the ceiling is
    // named and coverage becomes partial rather than "complete-within-scope".
    expect(archive.records[0]?.http_start_line_over_ceiling).toBe(true);
    expect(archive.records[0]?.http_omitted).toBe("start-line-limit");
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "http-start-line-limit-reached" }),
    ]);
    expect(archive.source_coverage.status).toBe("partial");
  });

  it("leaves an ordinary body undiagnosed at the same ceiling", () => {
    const html = `<html>${" ".repeat(9000)}</html>`;
    const archive = parsed(
      record("response", [["WARC-Record-ID", "<urn:1>"]], html),
    );
    expect(archive.records[0]?.http).toBeNull();
    expect(archive.records[0]?.http_start_line_over_ceiling).toBe(false);
    expect(archive.diagnostics).toEqual([]);
  });

  it("rejects a bare carriage return in a status line below the size cap", () => {
    // The quadratic-input case above is rejected by the size cap, so it never
    // exercises the character check. Without it this line produced
    // status_code 200 with reason_phrase "ok\rX".
    const archive = parsed(
      record(
        "response",
        [["WARC-Record-ID", "<urn:1>"]],
        "HTTP/1.1 200 ok\rX\r\n\r\n",
      ),
    );
    expect(archive.records[0]?.http).toBeNull();
    expect(archive.records[0]?.http_omitted).toBe("malformed-start-line");
  });

  it("keeps the reason phrase and rejects an out-of-range status", () => {
    const ok = parsed(
      record(
        "response",
        [["WARC-Record-ID", "<urn:1>"]],
        "HTTP/1.1  204\tNo Content  \r\n\r\n",
      ),
    );
    expect(ok.records[0]?.http).toMatchObject({
      status_code: 204,
      reason_phrase: "No Content",
    });
    const bad = parsed(
      record(
        "response",
        [["WARC-Record-ID", "<urn:2>"]],
        "HTTP/1.1 999 Nope\r\n\r\n",
      ),
    );
    expect(bad.records[0]?.http).toBeNull();
  });
});

describe("embedded HTTP messages", () => {
  it("decodes a request line as a request rather than a status", () => {
    const archive = parsed(
      record(
        "request",
        [["WARC-Target-URI", "https://example.test/a?q=1"]],
        "GET /a?q=1 HTTP/2\r\nHost: example.test\r\nAccept: */*\r\n\r\n",
      ),
    );
    expect(archive.records[0]?.http).toMatchObject({
      start_line: "GET /a?q=1 HTTP/2",
      version: "2",
      method: "GET",
      request_target: "/a?q=1",
      status_code: null,
      reason_phrase: null,
      body_bytes: 0,
      body_framing_declared: false,
    });
    expect(archive.records[0]?.http?.headers).toEqual([
      { name: "Host", value: "example.test" },
      { name: "Accept", value: "*/*" },
    ]);
    expect(archive.diagnostics).toEqual([]);
  });

  it("reports declared body framing without interpreting it", () => {
    const archive = parsed(
      record(
        "response",
        [["WARC-Target-URI", "https://example.test/a"]],
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
      ),
    );
    const http = archive.records[0]?.http;
    expect(http?.body_framing_declared).toBe(true);
    // The chunked body is counted as bytes present; it is not decoded.
    expect(http?.body_bytes).toBe("5\r\nhello\r\n0\r\n\r\n".length);
    expect(archive.source_coverage.http_bodies).toBe("not-decoded");
  });

  it("keeps a malformed header line as a diagnostic instead of a field", () => {
    const archive = parsed(
      record(
        "response",
        [["WARC-Record-ID", "<urn:1>"]],
        "HTTP/1.1 200 OK\r\nNoColonHere\r\nContent-Type: text/html\r\n\r\n",
      ),
    );
    expect(archive.records[0]?.http?.headers).toEqual([
      { name: "Content-Type", value: "text/html" },
    ]);
    expect(archive.records[0]?.http?.malformed_header_lines).toEqual([
      "NoColonHere",
    ]);
  });

  it("omits an unterminated header block instead of reading the body as headers", () => {
    const archive = parsed(
      record(
        "response",
        [["WARC-Record-ID", "<urn:1>"]],
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n<html>",
      ),
    );
    expect(archive.records[0]?.http).toBeNull();
    expect(archive.records[0]?.http_omitted).toBe("unterminated-header-block");
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "http-header-block-unterminated" }),
    ]);
    expect(archive.summary.http_omitted).toBe(1);
  });

  it("does not read a payload outside request and response records", () => {
    const archive = parsed(
      record(
        "resource",
        [["WARC-Record-ID", "<urn:1>"]],
        "GET /looks-like-a-request HTTP/1.1\r\n\r\n",
      ),
    );
    expect(archive.records[0]?.http).toBeNull();
    expect(archive.records[0]?.http_omitted).toBeNull();
    expect(archive.diagnostics).toEqual([]);
  });

  it("stops at the header block ceiling instead of reading a huge payload", () => {
    const fields = Array.from(
      { length: 2100 },
      (_, index) => `X-Pad-${index}: v`,
    ).join("\r\n");
    const archive = parsed(
      record(
        "response",
        [["WARC-Record-ID", "<urn:1>"]],
        `HTTP/1.1 200 OK\r\n${fields}\r\n\r\nbody`,
      ),
    );
    expect(archive.records[0]?.http).toBeNull();
    expect(archive.records[0]?.http_omitted).toBe("header-block-limit");
    expect(archive.diagnostics).toEqual([
      expect.objectContaining({ code: "http-header-block-limit-reached" }),
    ]);
  });
});

describe("bounded archives", () => {
  it("names the line ceiling rather than calling a long line truncated", () => {
    const longUri = `http://example.test/${"a".repeat(9000)}`;
    const archive = parsed(
      record("response", [
        ["WARC-Record-ID", "<urn:1>"],
        ["WARC-Target-URI", longUri],
      ]),
    );
    const codes = archive.diagnostics.map((d) => d.code);
    expect(codes).toContain("header-line-limit-reached");
    expect(codes).not.toContain("truncated-record");
    expect(
      archive.diagnostics.find((d) => d.code === "header-line-limit-reached")
        ?.message,
    ).toContain("8192");
  });

  it("enforces max_decoded_bytes on an uncompressed archive", () => {
    // The allowance was only applied on the gunzip path, so identity input was
    // scanned in full and could report complete coverage above the ceiling.
    const text = record("response", [["WARC-Record-ID", "<urn:1>"]]);
    const archive = parsed(text, { maxDecodedBytes: 10 });
    expect(archive.records).toEqual([]);
    expect(archive.diagnostics.map((d) => d.code)).toEqual([
      "decoded-size-limit-reached",
    ]);
    expect(archive.source_coverage.status).toBe("partial");
  });

  it("stops an oversized header while preserving earlier records and partial coverage", () => {
    const first = record("resource", [["WARC-Record-ID", "<urn:1>"]]);
    const manyShortLines = "bad\r\n".repeat(20_001);
    const archive = parsed(
      first + `WARC/1.1\r\n${manyShortLines}Content-Length: 0\r\n\r\n`,
      { maxDecodedBytes: 2 * 1024 * 1024 },
    );
    expect(archive.records.map((entry) => entry.warc_record_id)).toEqual([
      "<urn:1>",
    ]);
    expect(archive.source_coverage.status).toBe("partial");
    expect(archive.diagnostics.map((entry) => entry.code)).toContain(
      "header-block-limit-reached",
    );
    expect(archive.diagnostics.map((entry) => entry.code)).not.toContain(
      "truncated-record",
    );
  });

  it("stops a header whose total bytes exceed its allowance even when each line fits", () => {
    const lines = Array.from(
      { length: 150 },
      (_, i) => `X-${i}: ${"x".repeat(7200)}`,
    ).join("\r\n");
    const archive = parsed(
      `WARC/1.1\r\n${lines}\r\nContent-Length: 0\r\n\r\n`,
      { maxDecodedBytes: 2 * 1024 * 1024 },
    );
    expect(archive.records).toEqual([]);
    expect(archive.source_coverage.status).toBe("partial");
    expect(archive.diagnostics.map((entry) => entry.code)).toContain(
      "header-block-limit-reached",
    );
  });

  it("stops allocating diagnostics past the diagnostic ceiling", () => {
    // One record may carry millions of short malformed lines; `max_records`
    // does not bound that growth, and the reply-size check ran afterwards.
    const lines = Array.from(
      { length: 12_000 },
      (_, index) => `Bad Line ${index}`,
    ).join("\r\n");
    const archive = parsed(
      `WARC/1.1\r\nWARC-Type: response\r\n${lines}\r\nContent-Length: 0\r\n\r\n\r\n`,
    );
    expect(archive.diagnostics.length).toBeLessThanOrEqual(10_001);
    expect(archive.diagnostics.map((d) => d.code)).toContain(
      "diagnostic-limit-reached",
    );
  });
});
