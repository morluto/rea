import { describe, expect, it } from "vitest";

import {
  ghidraReplyEnvelope,
  type GhidraRemoteError,
} from "../ghidra/protocol.js";
import {
  JsonLineBridgeReader,
  type JsonLineBridgeFailure,
} from "./JsonLineBridgeReader.js";

type Response = Parameters<typeof ghidraReplyEnvelope.id>[0];

const readerFor = ({
  inFlight = [] as number[],
  nextId = 5,
  maxReplyBytes = 1024,
} = {}) => {
  const delivered: number[] = [];
  const rejected: GhidraRemoteError[] = [];
  const failures: JsonLineBridgeFailure[] = [];
  const pending = new Set(inFlight);
  const reader = new JsonLineBridgeReader<Response, GhidraRemoteError>({
    envelope: ghidraReplyEnvelope,
    maxReplyBytes: () => maxReplyBytes,
    deliver: (response) => {
      if (!pending.delete(response.id)) return false;
      delivered.push(response.id);
      return true;
    },
    wasSent: (id) => id < nextId,
    rejectInFlight: (cause) => {
      if (pending.size === 0) return false;
      pending.clear();
      rejected.push(cause);
      return true;
    },
    fail: (failure) => failures.push(failure),
  });
  return { reader, delivered, rejected, failures };
};

const success = (id: number) =>
  `{"id":${String(id)},"ok":true,"result":null}\n`;
const invalidRequest = (id: number) =>
  `{"id":${String(id)},"ok":false,"error":{"code":"invalid_request","message":"Bridge request is invalid"}}\n`;

describe("JSON-line bridge reader", () => {
  it("fails the requests in flight with a rejection on the reserved id", () => {
    const { reader, rejected, failures } = readerFor({ inFlight: [4] });

    reader.push(Buffer.from(invalidRequest(0)));

    expect(rejected).toMatchObject([
      { code: "invalid_request", message: "Bridge request is invalid" },
    ]);
    expect(failures).toEqual([]);
  });

  it("reports a reserved-id rejection with nothing in flight as a connection failure", () => {
    const { reader, failures } = readerFor();

    reader.push(Buffer.from(invalidRequest(0)));

    expect(failures).toMatchObject([
      {
        kind: "connection_rejected",
        cause: { message: "Bridge request is invalid" },
      },
    ]);
  });

  it("never accepts a success on the reserved id", () => {
    const { reader, failures } = readerFor({ inFlight: [4] });

    reader.push(Buffer.from('{"id":0,"ok":false}\n'));

    expect(failures).toMatchObject([{ kind: "envelope" }]);
  });

  it("ignores a late reply for a sent id and fails on an id never sent", () => {
    const { reader, delivered, failures } = readerFor({ inFlight: [2] });

    reader.push(Buffer.from(success(1) + success(2) + success(9) + success(2)));

    expect(delivered).toEqual([2]);
    expect(failures).toEqual([{ kind: "unknown_id", id: 9 }]);
  });

  it("stops reading after a failure until reset", () => {
    const { reader, delivered, failures } = readerFor({ inFlight: [3, 4] });

    reader.push(Buffer.from(`not json\n${success(3)}`));
    reader.push(Buffer.from(success(4)));
    expect(delivered).toEqual([]);
    expect(failures).toMatchObject([{ kind: "envelope" }]);

    reader.reset();
    reader.push(Buffer.from(success(4)));
    expect(delivered).toEqual([4]);
  });

  it("refuses an unterminated reply past the ceiling without waiting for its LF", () => {
    const { reader, failures } = readerFor({ maxReplyBytes: 1024 });

    reader.push(Buffer.from('{"id":1,"ok":true,"result":"'));
    reader.push(Buffer.alloc(1024, 0x78));

    expect(failures).toEqual([
      { kind: "reply_oversize", maximumBytes: 1024, observedBytes: 1052 },
    ]);
  });

  it("refuses a complete reply line longer than the ceiling", () => {
    const { reader, delivered, failures } = readerFor({
      inFlight: [1],
      maxReplyBytes: 64,
    });

    reader.push(
      Buffer.from(`{"id":1,"ok":true,"result":"${"x".repeat(64)}"}\n`),
    );

    expect(delivered).toEqual([]);
    expect(failures).toMatchObject([
      { kind: "reply_oversize", maximumBytes: 64 },
    ]);
  });

  it("reports malformed UTF-8 as its own failure", () => {
    const { reader, failures } = readerFor({ inFlight: [1] });

    reader.push(
      Buffer.concat([
        Buffer.from('{"id":1,"ok":true,"result":"'),
        Buffer.from([0xff]),
        Buffer.from('"}\n'),
      ]),
    );

    expect(failures).toMatchObject([{ kind: "utf8" }]);
  });
});
