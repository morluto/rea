import { expect, it, vi } from "vitest";
import * as paths from "./environmentStateRules.js";
import { prefixRelated } from "./environmentStateWriteRules.js";
import { CapturedWriteCompletion } from "./environmentStateWriteCompletion.js";

it("preserves the existing prefix relation, including non-transitive decoding and parameters", () => {
  const spellings = [
    "",
    "api",
    "a",
    "%61",
    "%2561",
    "%2F",
    "%252F",
    "{id}",
    "%ZZ",
  ];
  const candidates = [
    "/",
    ...spellings.flatMap((value) => [
      `/api/${value}`,
      `/api/${value}/child`,
      `/${value}/other`,
    ]),
  ];
  for (const write of candidates) {
    const completion = new CapturedWriteCompletion(() => {});
    completion.write(write, undefined, -Infinity, 1);
    for (const read of candidates)
      expect(completion.runningAt(read, 100), `${write} -> ${read}`).toBe(
        prefixRelated(write, read),
      );
  }
});

it("retains unknown completion and isolates unrelated writes while aggregating known ends", () => {
  const completion = new CapturedWriteCompletion(() => {});
  completion.write("/api/books/1", 20, -Infinity, 2);
  completion.write("/api/books/1", 30, -Infinity, 3);
  completion.write("/api/books/2", undefined, -Infinity, 4);
  completion.write("/api/books/2", 10, -Infinity, 5);
  expect(completion.runningAt("/api/books/1", 29)).toBe(true);
  expect(completion.runningAt("/api/books/1", 30)).toBe(false);
  expect(completion.runningAt("/api/books/1", undefined)).toBe(true);
  expect(completion.runningAt("/api/books/2", 100)).toBe(true);
  expect(completion.runningAt("/api/books", 100)).toBe(true);
  expect(completion.runningAt("/api/authors", undefined)).toBe(false);
  completion.write("/", undefined, -Infinity, 6);
  expect(completion.runningAt("/api/authors", 100)).toBe(true);
});

it("uses explicit record-order coordinates without treating absent writes as pending", () => {
  const completion = new CapturedWriteCompletion(() => {});
  expect(completion.runningAt("/api/books", undefined)).toBe(false);
  completion.write("/api/books", 1, -Infinity, 7);
  expect(completion.runningAt("/api/books/1", 2)).toBe(false);
});

it("looks up a concrete path without reinterpreting every retained write path", () => {
  const completion = new CapturedWriteCompletion(() => {});
  for (let id = 0; id < 128; id += 1)
    completion.write(`/api/books/${String(id)}`, undefined, -Infinity, id);
  const decoded = vi.spyOn(paths, "decodedSegment");
  try {
    expect(completion.runningAt("/api/books/64", 100)).toBe(true);
    // Matching interprets only the three read segments; prior write segments were indexed once.
    expect(decoded).toHaveBeenCalledTimes(3);
  } finally {
    decoded.mockRestore();
  }
});

it("reserves retained prefix growth before publishing an unbudgeted edge", () => {
  const refused = new Error("state retained-memory budget exhausted");
  let remaining = Infinity;
  const completion = new CapturedWriteCompletion((bytes) => {
    if (bytes > remaining) throw refused;
    remaining -= bytes;
  });
  completion.write("/api/books/1", 10, -Infinity, 9);
  remaining = 0;
  // Updating an indexed path retains no new keys or nodes.
  completion.write("/api/books/1", 20, -Infinity, 10);
  expect(completion.runningAt("/api/books/1", 19)).toBe(true);
  expect(() =>
    completion.write("/api/authors/1", undefined, -Infinity, 11),
  ).toThrow(refused);
  expect(completion.runningAt("/api/authors/1", 100)).toBe(false);
  expect(completion.runningAt("/api", 100)).toBe(false);
  expect(completion.runningAt("/", 100)).toBe(false);
  expect(completion.runningAt("/api/{collection}", 100)).toBe(false);
  expect(completion.runningAt("/api/books/1", 20)).toBe(false);
});

it("queries both interval boundaries across future writes in chronology order", () => {
  const completion = new CapturedWriteCompletion(() => {});
  completion.write("/api/books/1", 15, 10, 12);
  completion.write("/api/books/1", undefined, 30, 13);
  expect(completion.runningAt("/api/books/1", 5, 10)).toBe(false);
  expect(completion.runningAt("/api/books/1", 5, 11)).toBe(true);
  expect(completion.runningAt("/api/books/1", 15, 30)).toBe(false);
  expect(completion.runningAt("/api/books/1", 15, 31)).toBe(true);
  expect(completion.runningAt("/api/books/1", 15, undefined)).toBe(true);
  expect(completion.runningAt("/api/authors", 5, undefined)).toBe(false);
});

it("keeps a simultaneous unknown write ambiguous for a point read, unlike a known point write", () => {
  const completion = new CapturedWriteCompletion(() => {});
  completion.write("/api/books/1", undefined, 10, 14);
  completion.write("/api/books/2", 10, 10, 15);
  expect(completion.runningAt("/api/books/1", 10, 10)).toBe(true);
  expect(completion.runningAt("/api/books/2", 10, 10)).toBe(false);
  expect(completion.runningAt("/api/books/3", 10, 10)).toBe(false);
});

it("excludes only the source write while retaining simultaneous and unknown competitors", () => {
  const completion = new CapturedWriteCompletion(() => {});
  completion.write("/api/books/1", 20, 10, 1);
  expect(completion.runningAt("/api/books/1", 10, 20, 1)).toBe(false);
  completion.write("/api/books/1", 12, 10, 2);
  expect(completion.runningAt("/api/books/1", 10, 20, 1)).toBe(true);
  expect(completion.runningAt("/api/books/1", 12, 20, 1)).toBe(false);
  completion.write("/api/books/1", undefined, 10, 3);
  expect(completion.runningAt("/api/books/1", 100, 101, 1)).toBe(true);
  expect(completion.runningAt("/api/books/1", 100, 101, 3)).toBe(false);
  expect(completion.runningAt("/api/books/2", 10, 20, 1)).toBe(false);
});

it("matches raw interval overlap when excluding each write", () => {
  const writes = [
    { id: 1, start: 0, end: 20 },
    { id: 2, start: 1, end: 5 },
    { id: 3, start: 1, end: undefined },
    { id: 4, start: 4, end: 4 },
  ];
  const completion = new CapturedWriteCompletion(() => {});
  for (const write of writes)
    completion.write("/api/books/1", write.end, write.start, write.id);
  for (const start of [0, 1, 4, 5, 20, 30])
    for (const end of [start, start + 1, 30])
      for (const excluded of [undefined, ...writes.map(({ id }) => id)]) {
        const expected = writes.some(
          (write) =>
            write.id !== excluded &&
            (write.start < end || (start === end && write.start === end)) &&
            (write.end === undefined || write.end > start),
        );
        expect(completion.runningAt("/api/books/1", start, end, excluded)).toBe(
          expected,
        );
      }
});
