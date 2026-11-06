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

  it("reports the embedded HTTP status line without decoding bodies", () => {
    const archive = parsed(
      record(
        "response",
        [["WARC-Target-URI", "https://example.test/a"]],
        "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\nmissing",
      ),
    );
    expect(archive.records[0]?.http).toEqual({
      status_code: 404,
      reason_phrase: "Not Found",
      header_bytes: "HTTP/1.1 404 Not Found\r\n".length,
    });
    expect(archive.source_coverage.http_bodies).toBe("not-decoded");
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
});
