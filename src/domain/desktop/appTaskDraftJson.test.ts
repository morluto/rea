import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { draftOf, pointerOf, statePath } from "./appTaskDraft.fixture.js";
import { evaluateTaskChecks, type TaskFileView } from "./appTaskChecks.js";
import { jsonCounts } from "./appTaskDraftJson.js";
import { pairRecordsById } from "./jsonRecordPairing.js";
import type { DesktopTaskCheckInput } from "./appTask.js";

const FILE = "Documents/reading-list.trln";

/** A TreeLine outline: nodes saved sorted by their generated uid1, each with its kind (`format`), data and children's uids. */
const outline = (
  books: readonly (readonly [string, string])[],
  title = "The Guns of August",
) => {
  const history = {
    children: books.map(([uid]) => uid),
    data: { NAME: "History" },
    format: "CATEGORY",
    uid: "7584d494d9f511f1a873edd4f1920549",
  };
  const nodes = [
    history,
    ...books.map(([uid, name]) => ({
      children: [],
      data: { Title: name === "Guns" ? title : name, Year: "2015" },
      format: "BOOK",
      uid,
    })),
  ].toSorted((left, right) => (left.uid < right.uid ? -1 : 1));
  return { nodes } as unknown as JsonValue;
};
const GUNS = ["812403bed9f511f19fc4edd4f1920549", "Guns"] as const;
const SPQR = ["84f27625d9f511f188ededd4f1920549", "SPQR"] as const;
const drafted = (before: JsonValue, after: JsonValue) => {
  const [file] = draftOf({
    [FILE]: statePath("document", "json", before, after),
  });
  if (file === undefined) throw new Error("the file did not change");
  return file;
};
const passing = (view: JsonValue, checks: readonly DesktopTaskCheckInput[]) =>
  evaluateTaskChecks(
    checks.map((check, index) => ({ ...check, id: `c${String(index)}` })),
    new Map([[FILE, { format: "json" as const, view }]]),
  ).map(({ passed }) => passed);

describe("draftTaskFiles for records in a JSON array, as TreeLine saves its nodes", () => {
  it("names a kept record by its uid, so the edit's check holds in whatever order the app saves the records, and guards their count", () => {
    const file = drafted(
      outline([GUNS, SPQR]),
      outline([GUNS, SPQR], "The Guns of August, revised"),
    );

    const guns = "/nodes/[uid=812403bed9f511f19fc4edd4f1920549]";
    expect(file.suggested).toEqual([
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${guns}/data/Title`,
        value: "The Guns of August, revised",
      },
    ]);
    expect(file.guards).toEqual([
      { kind: "member_count", file: FILE, pointer: "/nodes", equals: 3 },
    ]);
    // Another save lists the records in another order.
    const reordered = outline([SPQR, GUNS], "The Guns of August, revised");
    expect(passing(reordered, file.suggested)).toEqual([true]);
  });

  it("counts the records a new one joins, of its kind, never suggests the uid the app generated, and notes the checks only position reaches", () => {
    const book = [
      "fc11808dd9f511f181b7edd4f1920549",
      "The Silk Roads",
    ] as const;
    const file = drafted(outline([GUNS, SPQR]), outline([GUNS, SPQR, book]));

    expect(
      file.suggested.filter(({ kind }) => kind === "member_count"),
    ).toEqual([
      {
        kind: "member_count",
        file: FILE,
        pointer: "/nodes",
        matching: "[format=BOOK]",
        equals: 3,
      },
      {
        kind: "member_count",
        file: FILE,
        pointer: "/nodes/[uid=7584d494d9f511f1a873edd4f1920549]/children",
        equals: 3,
      },
    ]);
    expect(
      file.suggested.some(
        (check) => "value" in check && check.value === book[0],
      ),
    ).toBe(false);
    const positional = file.suggested
      .map(pointerOf)
      .filter((pointer) => pointer?.startsWith("/nodes/3"));
    expect(positional).toContain("/nodes/3/data/Title");
    expect(file.notes).toMatchObject([
      { code: "by_position", pointers: expect.arrayContaining(positional) },
    ]);
  });

  it("checks nothing the seed already holds, nor a removed record's place another record takes, when position alone reaches the records", () => {
    const seed = outline([GUNS, SPQR]);
    // A uid sorting between the others puts the new book where SPQR was.
    const middle = ["830000aad9f511f19fc4edd4f1920549", "Silk"] as const;
    const added = drafted(seed, outline([GUNS, middle, SPQR]));
    const removed = drafted(outline([GUNS, middle, SPQR]), seed);

    for (const [file, before, after] of [
      [added, seed, outline([GUNS, middle, SPQR])],
      [removed, outline([GUNS, middle, SPQR]), seed],
    ] as const) {
      expect(file.suggested.length).toBeGreaterThan(0);
      expect(passing(before, file.suggested).filter(Boolean)).toEqual([]);
      expect(passing(after, file.suggested).every(Boolean)).toBe(true);
    }
    expect(added.suggested.map(pointerOf)).not.toContain("/nodes/2/format");
    expect(
      removed.suggested
        .map(pointerOf)
        .filter((pointer) => pointer?.startsWith("/nodes/2")),
    ).toEqual([]);
  });
});

describe("draftTaskFiles for records a JSON array names by a field", () => {
  const board = (lists: readonly string[]) =>
    ({
      lists: lists.map((id) => ({
        id,
        title: `${id[0]?.toUpperCase() ?? ""}${id.slice(1)}`,
        done: false,
      })),
    }) as unknown as JsonValue;

  it("checks a removed record is gone by its own selector, which the end resolves to nothing, never its fields through it", () => {
    const seed = board(["groceries", "chores", "work"]);
    const end = board(["groceries", "work"]);
    const file = drafted(seed, end);

    expect(file.suggested).toEqual([
      { kind: "value_absent", file: FILE, pointer: "/lists/[id=chores]" },
      { kind: "member_count", file: FILE, pointer: "/lists", equals: 2 },
    ]);
    expect(passing(seed, file.suggested)).toEqual([false, false]);
    expect(passing(end, file.suggested)).toEqual([true, true]);
  });
});

describe("jsonCounts over many edited records", () => {
  it("reads the edits only until one gives the count guard, not every edited record", () => {
    const rows = (bump: number) =>
      ({
        rows: Array.from({ length: 1000 }, (_, index) => ({
          name: `r${String(index)}`,
          n: index + bump,
        })),
      }) as unknown as JsonValue;
    let read = 0;
    const changed = new Proxy(
      Array.from(
        { length: 1000 },
        (_, index) => `/rows/[name=r${String(index)}]/n`,
      ),
      {
        get: (target, key, receiver) => {
          if (typeof key === "string" && /^\d+$/u.test(key)) read += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      },
    );

    const { guards } = jsonCounts(
      FILE,
      { added: [], changed, removed: [] },
      { baseline: rows(0), final: rows(1) },
    );

    expect(guards).toEqual([
      { kind: "member_count", file: FILE, pointer: "/rows", equals: 1000 },
    ]);
    expect(read).toBe(1);
  });

  it("does not count a JSON array that was removed, and counts a top-level array", () => {
    const removed = drafted({ items: ["a", "b"] }, {});
    expect(
      removed.suggested.some(
        (check) => check.kind === "member_count" && check.equals === 0,
      ),
    ).toBe(false);

    const added = drafted(
      [
        { uid: "a", name: "Ada" },
        { uid: "b", name: "Lin" },
      ],
      [
        { uid: "a", name: "Ada" },
        { uid: "b", name: "Lin" },
        { uid: "c", name: "Kai" },
      ],
    );
    expect(added.suggested).toContainEqual({
      kind: "member_count",
      file: FILE,
      pointer: "",
      equals: 3,
    });
    const graded = (view: TaskFileView["view"]) =>
      evaluateTaskChecks(
        added.suggested.map((check, index) => ({
          ...check,
          id: `c${String(index)}`,
        })),
        new Map([[FILE, { format: "json", view }]]),
      ).map(({ passed }) => passed);
    expect(
      graded([
        { uid: "a", name: "Ada" },
        { uid: "b", name: "Lin" },
      ]),
    ).toContain(false);
    expect(
      graded([
        { uid: "a", name: "Ada" },
        { uid: "b", name: "Lin" },
        { uid: "c", name: "Kai" },
      ]).every(Boolean),
    ).toBe(true);
  });

  it("pairs records by uid when parent_id also names each", () => {
    const before = [
      { parent_id: "root", uid: "a", name: "Ada" },
      { parent_id: "root", uid: "b", name: "Lin" },
    ];
    const after = [
      { parent_id: "moved", uid: "a", name: "Ada" },
      { parent_id: "root", uid: "b", name: "Lin" },
    ];
    const paired = pairRecordsById(after, before);

    expect(paired?.newer.keys).toEqual(["[uid=a]", "[uid=b]"]);
  });

  it("does not pair records through a field whose name is a selector mark", () => {
    const records = (name: string) => [
      { "@record_id": "one", name },
      { "@record_id": "two", name: "Lin" },
    ];

    expect(
      pairRecordsById(records("Ada Lane"), records("Ada")),
    ).toBeUndefined();
  });
});
