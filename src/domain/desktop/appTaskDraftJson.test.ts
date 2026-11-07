import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { draftOf, pointerOf, statePath } from "./appTaskDraft.fixture.js";
import { evaluateTaskChecks } from "./appTaskChecks.js";
import { jsonCounts } from "./appTaskDraftJson.js";
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
      data: {
        Title: name === "Guns" ? title : name,
        Year: name === "Guns" ? "1962" : "2015",
      },
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
  it("names kept records by name fields of at most 64 kinds, each a pass over the records, and those past them by their uid", () => {
    /** Seventy records with a generated uid, each with a name field of its own key and `done` as `edited` says. */
    const items = (edited: (index: number) => boolean) =>
      ({
        items: Array.from({ length: 70 }, (_, index) => ({
          [`n${String(index)}name`]: `Item ${String(index)}`,
          done: edited(index),
          uid: `${String(index).padStart(8, "0")}da2511f1a0ba3971baf6a808`,
        })),
      }) as unknown as JsonValue;
    const file = drafted(
      items(() => false),
      items((index) => index === 0 || index === 69),
    );

    expect(file.suggested.map(pointerOf)).toEqual([
      "/items/[n0name=Item 0]/done",
      "/items/[uid=00000069da2511f1a0ba3971baf6a808]/done",
    ]);
  });

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

  it("counts the records a new one joins, of its kind, never suggests the uid the app generated, and names the new record by its kind and title, checking its other fields through that", () => {
    const book = [
      "fc11808dd9f511f181b7edd4f1920549",
      "The Silk Roads",
    ] as const;
    const seed = outline([GUNS, SPQR]);
    const file = drafted(seed, outline([GUNS, SPQR, book]));

    const silk = "/nodes/[format=BOOK][>data~1Title=The Silk Roads]";
    expect(file.suggested).toEqual([
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${silk}/data/Year`,
        value: "2015",
      },
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
        pointer: "/nodes/[format=CATEGORY][>data~1NAME=History]/children",
        equals: 3,
      },
    ]);
    expect(file.notes).toEqual([]);
    // Another run of the edit generates another uid, which sorts the new record elsewhere.
    const rerun = outline([
      GUNS,
      SPQR,
      ["0a11808dd9f511f181b7edd4f1920549", "The Silk Roads"],
    ]);
    expect(passing(seed, file.suggested)).toEqual([false, false, false]);
    expect(passing(rerun, file.suggested)).toEqual([true, true, true]);
  });

  it("checks a removed record with a generated uid is gone by its kind and title, and keeps position and its note where a title another record shares names nothing", () => {
    const book = [
      "fc11808dd9f511f181b7edd4f1920549",
      "The Silk Roads",
    ] as const;
    const removed = drafted(outline([GUNS, SPQR, book]), outline([GUNS, SPQR]));
    const twin = drafted(
      outline([GUNS, SPQR]),
      outline([GUNS, SPQR, ["fc11808dd9f511f181b7edd4f1920549", "SPQR"]]),
    );

    expect(removed.suggested).toContainEqual({
      kind: "value_absent",
      file: FILE,
      pointer: "/nodes/[format=BOOK][>data~1Title=The Silk Roads]",
    });
    const positional = twin.suggested
      .map(pointerOf)
      .filter((pointer) => pointer?.startsWith("/nodes/3"));
    expect(positional).toContain("/nodes/3/data/Title");
    expect(twin.notes).toMatchObject([
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

describe("draftTaskFiles for a new JSON record named by a field inside it", () => {
  it("checks a new record by the field that names it when nothing else reads it, so a wrong title fails however many records the list holds", () => {
    const note = (uid: string, title: string) => ({
      data: { Title: title },
      uid,
    });
    const NEW = note("fc11808dd9f511f181b7edd4f1920549", "New");
    const OLD = note("812403bed9f511f19fc4edd4f1920549", "Old");
    const nodes = (...members: unknown[]) =>
      ({ nodes: members }) as unknown as JsonValue;
    const titled = {
      kind: "value_equals",
      file: FILE,
      pointer: "/nodes/[>data~1Title=New]/data/Title",
      value: "New",
    };
    const first = drafted(nodes(), nodes(NEW));
    const joined = drafted(nodes(OLD), nodes(OLD, NEW));

    expect(first.suggested).toEqual([titled]);
    expect(joined.suggested).toEqual([
      titled,
      { kind: "member_count", file: FILE, pointer: "/nodes", equals: 2 },
    ]);
    // Another run gives the record another uid; a wrong title fails.
    const rerun = note("0a11808dd9f511f181b7edd4f1920549", "New");
    expect(passing(nodes(rerun), first.suggested)).toEqual([true]);
    expect(passing(nodes(OLD, note(NEW.uid, "Nwe")), joined.suggested)).toEqual(
      [false, true],
    );
  });

  it("checks a record added to a top-level array that repeats its like records' fields, since no count reaches that array", () => {
    const note = (uid: string) => ({ data: { Title: "Same" }, uid });
    const seed = [note("812403bed9f511f19fc4edd4f1920549")] as JsonValue;
    const end = [
      note("812403bed9f511f19fc4edd4f1920549"),
      note("fc11808dd9f511f181b7edd4f1920549"),
    ] as JsonValue;
    const file = drafted(seed, end);

    expect(file.suggested.map(pointerOf)).toEqual(["/1/data/Title"]);
    expect(passing(seed, file.suggested).some((passed) => !passed)).toBe(true);
    expect(passing(end, file.suggested).every(Boolean)).toBe(true);
  });

  it("names a new record by a later name-like field when the first three name another record too", () => {
    const item = (uid: string, last: string, done: boolean) => ({
      aname: "Shared",
      bname: "Shared",
      cname: "Shared",
      dname: last,
      done,
      uid,
    });
    const FIRST = "00000001da2511f1a0ba3971baf6a808";
    const items = (...members: unknown[]) =>
      ({ items: members }) as unknown as JsonValue;
    const file = drafted(
      items(item(FIRST, "First", false)),
      items(
        item(FIRST, "First", false),
        item("00000002da2511f1a0ba3971baf6a808", "Second", true),
      ),
    );

    expect(file.suggested.map(pointerOf)).toEqual([
      "/items/[dname=Second]/dname",
      "/items/[dname=Second]/done",
      "/items",
    ]);
    expect(file.notes).toEqual([]);
  });
});

type Book = readonly [
  uid: string,
  title: string,
  author: string,
  copyright: string,
  plot?: string,
];
/** The seed's categories and books, as the run's `reading-list.trln` held them. */
const SEED: readonly (readonly [uid: string, name: string, books: Book[]])[] = [
  [
    "0b7bfb76959211e7a8357054d2175f18",
    "Fiction",
    [
      [
        "2d4390ceda2511f195a23971baf6a808",
        "The Cartographer's Daughter",
        "Lena Whitcombe",
        "2016",
        "A mapmaker's heir follows her mother's unfinished charts north.",
      ],
      [
        "4eb3fbd2da2511f188893971baf6a808",
        "Winter at Marrow Bay",
        "Joel Ashby",
        "2012",
        "A lighthouse keeper spends a last season on a fading island.",
      ],
    ],
  ],
  [
    "53f0d9c3da2511f1a8913971baf6a808",
    "History",
    [
      [
        "60e26394da2511f198393971baf6a808",
        "The Salt Caravans",
        "Mira Okonkwo",
        "2014",
        "How desert trade routes carried salt, gold and news across centuries.",
      ],
      [
        "668660d1da2511f1b0ee3971baf6a808",
        "Lanterns of the Old Port",
        "Tomas Reyes",
        "2009",
        "A harbor town told through its lamplighters and their ledgers.",
      ],
    ],
  ],
  [
    "75201b5ada2511f1a0ba3971baf6a808",
    "Science",
    [
      [
        "76cbaf8fda2511f1b9343971baf6a808",
        "The Quiet Glacier",
        "Ines Halvorsen",
        "2018",
        "A field season spent measuring a retreating ice sheet.",
      ],
      [
        "7be27d14da2511f1afb93971baf6a808",
        "Small Engines of Life",
        "Dev Ramanathan",
        "2021",
        "A tour of the molecular machines inside every cell.",
      ],
    ],
  ],
];
/** The book the agent added under Science, with no plot. */
const CLOCKWORK: Book = [
  "ae23424ada2511f1bbd43971baf6a808",
  "The Clockwork Ocean",
  "Priya Lindqvist",
  "2020",
];
/** The outline's nodes sorted by uid, as TreeLine saves them, with `added` under Science and `rename` naming categories anew. */
const outlineOf = (
  added: readonly Book[] = [],
  rename: Readonly<Record<string, string>> = {},
) => {
  const categories = SEED.map(([uid, name, books]) => ({
    uid,
    name: rename[name] ?? name,
    books: name === "Science" ? [...books, ...added] : books,
  }));
  const nodes = [
    ...categories.map(({ uid, name, books }) => ({
      children: books.map(([id]) => id),
      data: { NAME: name },
      format: "CATEGORY",
      uid,
    })),
    ...categories.flatMap(({ books }) =>
      books.map(([uid, title, author, copyright, plot]) => ({
        children: [],
        data: {
          Author: author,
          Copyright: copyright,
          ...(plot === undefined ? {} : { Plot: plot }),
          Title: title,
        },
        format: "BOOK",
        uid,
      })),
    ),
  ].toSorted((left, right) => (left.uid < right.uid ? -1 : 1));
  return { nodes } as unknown as JsonValue;
};
const book = (title: string) => `/nodes/[format=BOOK][>data~1Title=${title}]`;

describe("draftTaskFiles for a book added under a category, as TreeLine saved one on a real run", () => {
  it("checks the new book's author and copyright, not the empty children every book holds, guards the nearest books' same fields named by their titles, and names Science by its name", () => {
    const seed = outlineOf();
    const end = outlineOf([CLOCKWORK]);
    const file = drafted(seed, end);

    expect(file.suggested).toEqual([
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${book("The Clockwork Ocean")}/data/Author`,
        value: "Priya Lindqvist",
      },
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${book("The Clockwork Ocean")}/data/Copyright`,
        value: "2020",
      },
      {
        kind: "member_count",
        file: FILE,
        pointer: "/nodes",
        matching: "[format=BOOK]",
        equals: 7,
      },
      {
        kind: "member_count",
        file: FILE,
        pointer: "/nodes/[format=CATEGORY][>data~1NAME=Science]/children",
        equals: 3,
      },
    ]);
    expect(file.guards).toEqual([
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${book("Small Engines of Life")}/data/Author`,
        value: "Dev Ramanathan",
      },
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${book("The Quiet Glacier")}/data/Author`,
        value: "Ines Halvorsen",
      },
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${book("Small Engines of Life")}/data/Copyright`,
        value: "2021",
      },
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${book("The Quiet Glacier")}/data/Copyright`,
        value: "2018",
      },
    ]);
    expect(passing(seed, file.suggested)).toEqual([false, false, false, false]);
    expect(passing(end, file.suggested)).toEqual([true, true, true, true]);
    expect(passing(seed, file.guards)).toEqual([true, true, true, true]);
    expect(passing(end, file.guards)).toEqual([true, true, true, true]);
  });

  it("guards the nearest books and skips the children every book holds where the nodes are the file's top level", () => {
    const top = (view: JsonValue) => (view as { nodes: JsonValue }).nodes;
    const at = (title: string) => book(title).replace(/^\/nodes/u, "");
    const seed = top(outlineOf());
    const end = top(outlineOf([CLOCKWORK]));
    const file = drafted(seed, end);

    expect(file.suggested.map(pointerOf)).not.toContain(
      `${at("The Clockwork Ocean")}/children`,
    );
    expect(file.guards.map(pointerOf)).toEqual([
      `${at("Small Engines of Life")}/data/Author`,
      `${at("The Quiet Glacier")}/data/Author`,
      `${at("Small Engines of Life")}/data/Copyright`,
      `${at("The Quiet Glacier")}/data/Copyright`,
    ]);
    expect(passing(seed, file.guards)).toEqual([true, true, true, true]);
    expect(passing(end, file.guards)).toEqual([true, true, true, true]);
  });

  it("names a kept category by its uid where its name changed or another category holds it", () => {
    const children = (file: ReturnType<typeof drafted>) =>
      file.suggested
        .map(pointerOf)
        .filter((pointer) => pointer?.endsWith("/children"));
    const renamed = drafted(
      outlineOf(),
      outlineOf([CLOCKWORK], { Science: "Natural Science" }),
    );
    const shared = drafted(
      outlineOf([], { Science: "History" }),
      outlineOf([CLOCKWORK], { Science: "History" }),
    );

    for (const file of [renamed, shared])
      expect(children(file)).toEqual([
        "/nodes/[uid=75201b5ada2511f1a0ba3971baf6a808]/children",
      ]);
  });

  it("reads at most the 16 nearest like books for a guard, so none further out guards the new one", () => {
    /** Forty books in uid order, each authored as `author` says, and the new one after them. */
    const shelf = (author: (index: number) => string, added: boolean) =>
      ({
        nodes: [
          ...Array.from({ length: 40 }, (_, index) => ({
            data: { Author: author(index), Title: `Volume ${String(index)}` },
            format: "BOOK",
            uid: `${String(index).padStart(8, "0")}da2511f1a0ba3971baf6a808`,
          })),
          ...(added
            ? [
                {
                  data: { Author: CLOCKWORK[2], Title: CLOCKWORK[1] },
                  format: "BOOK",
                  uid: CLOCKWORK[0],
                },
              ]
            : []),
        ],
      }) as unknown as JsonValue;
    const author = (index: number) => `Author ${String(index)}`;
    // The 15 nearest books were re-authored: the 16th nearest, Volume 24, guards, and Volume 23, past the 16, does not.
    const file = drafted(
      shelf(author, false),
      shelf(
        (index) => `${author(index)}${index > 24 ? ", revised" : ""}`,
        true,
      ),
    );

    expect(file.guards).toEqual([
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${book("Volume 24")}/data/Author`,
        value: "Author 24",
      },
    ]);
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
});
