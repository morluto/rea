import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import { draftOf, pointerOf, statePath } from "./appTaskDraft.fixture.js";
import { evaluateTaskChecks } from "./appTaskChecks.js";
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
});
