import { expect, it } from "vitest";
import {
  parseTsharkJsonPackets,
  readTsharkJsonPackets,
} from "./TsharkJsonPackets.js";

const budget = (maxBytes: number, maxDecodedBytes: number) => ({
  maxBytes,
  maxDecodedBytes,
  decodedBytes: 0,
});

it("returns each packet's layers in order and drops export metadata", () => {
  const read = parseTsharkJsonPackets(
    JSON.stringify([
      { _index: "packets", _score: null, _source: { layers: { a: ["1"] } } },
      { _source: { layers: { frame: { "frame.number": "2" } } } },
    ]),
  );
  expect(read).toEqual({
    ok: true,
    value: [{ a: ["1"] }, { frame: { "frame.number": "2" } }],
  });
});

it.each([
  ["truncated JSON", '[{"_source":', "malformed-json"],
  ["a non-array root", '{"_source":{}}', "malformed-packet"],
  [
    "a packet without layers",
    '[{"_source":{"layers":[]}}]',
    "malformed-packet",
  ],
])("refuses %s with a typed failure", (_label, text, kind) => {
  const read = parseTsharkJsonPackets(text);
  expect(read).toMatchObject({ ok: false, error: { kind } });
});

it("names the first packet whose envelope is malformed", () => {
  const read = parseTsharkJsonPackets(
    JSON.stringify([{ _source: { layers: {} } }, { _source: null }]),
  );
  expect(read).toEqual({
    ok: false,
    error: {
      kind: "malformed-packet",
      reason: "packet 2 lacks _source.layers",
    },
  });
});

it("refuses text over the byte bound before estimating its expansion", async () => {
  const shared = budget(4, 1024);
  const read = await readTsharkJsonPackets("[{}, {}]", shared);
  expect(read).toEqual({
    ok: false,
    error: { kind: "json-bytes", maxBytes: 4 },
  });
  expect(shared.decodedBytes).toBe(0);
});

it("charges expansion across acquisitions that share one budget", async () => {
  const shared = budget(1024, 600);
  const first = await readTsharkJsonPackets("[]", shared);
  expect(first).toEqual({ ok: true, value: [] });
  const second = await readTsharkJsonPackets(
    JSON.stringify([{ _source: { layers: { a: ["1"] } } }]),
    shared,
  );
  expect(second).toEqual({
    ok: false,
    error: { kind: "json-expansion", maxDecodedBytes: 600 },
  });
});

it("returns the caller's abort reason without parsing", async () => {
  const controller = new AbortController();
  const reason = new Error("stopped");
  controller.abort(reason);
  const read = await readTsharkJsonPackets(
    "not json",
    budget(1024, 1024),
    controller.signal,
  );
  expect(read).toEqual({
    ok: false,
    error: { kind: "cancelled", cause: reason },
  });
});
