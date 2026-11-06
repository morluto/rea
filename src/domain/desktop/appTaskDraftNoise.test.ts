import { describe, expect, it } from "vitest";

import { pointerOf, xmlDraft } from "./appTaskDraft.fixture.js";

const CELLS =
  "/root/children/[name=Sheet]/children/[name=Cells]/children/[name=Cell]";
const SELECTIONS = "/root/children/[name=Sheet]/children/[name=Selections]";

/** A spreadsheet's save: where the cursor was, its cells, and what the app stamps on the file. */
const workbook = (save: {
  cursor: string;
  march: string;
  totals: readonly [string, string];
  session: string;
  saved: string;
  date: string;
}) =>
  `<Workbook><meta session="${save.session}" saved="${save.saved}"><generator>Sheets 1.0</generator><date>${save.date}</date></meta><Sheet><Selections CursorCol="${save.cursor}" CursorRow="${save.cursor}"><Selection startCol="${save.cursor}" endCol="${save.cursor}"/></Selections><Cells><Cell Row="2" Col="3">${save.march}</Cell><Cell Row="2" Col="4">17.5</Cell><Cell Row="5" Col="3" ExprID="${save.totals[0]}">${save.totals[0] === "1" ? "" : "=sum(C2:C4)"}</Cell><Cell Row="5" Col="4" ExprID="${save.totals[1]}">${save.totals[1] === "1" ? "" : "=sum(D2:D4)"}</Cell></Cells></Sheet></Workbook>`;

const SEED = {
  cursor: "0",
  march: "405.1",
  totals: ["2", "3"],
  session: "0b5c1f0e-3c1d-4f7a-9a3e-2d7f5b8c9e10",
  saved: "1793870431",
  date: "2026-11-05T23:45:25Z",
} as const;
/** The save after the edit: the app also moved the cursor, renumbered the shared formulas and stamped the file anew. */
const EDITED = {
  cursor: "3",
  march: "437.8",
  totals: ["1", "1"],
  session: "7d1e2a90-5b4c-4e8f-8a21-6c3b9f0d4e57",
  saved: "1793870500",
  date: "2026-11-05T23:47:01Z",
} as const;

describe("draftTaskFiles noise", () => {
  it("leaves view state, renumbered ids, volatile values and times out of a document's suggestions when an edit is there, noting each in values", () => {
    const file = xmlDraft(workbook(SEED), workbook(EDITED));

    expect(file.suggested.map(pointerOf)).toEqual([
      `${CELLS}[@Col=3][@Row=2]/children/0`,
    ]);
    const noted = (note: string) =>
      file.values
        .filter((value) => value.note === note)
        .map(({ pointer }) => pointer)
        .toSorted();
    expect(noted("view_state")).toEqual(
      [
        `${SELECTIONS}/attributes/CursorCol`,
        `${SELECTIONS}/attributes/CursorRow`,
        `${SELECTIONS}/children/[name=Selection]/attributes/endCol`,
        `${SELECTIONS}/children/[name=Selection]/attributes/startCol`,
      ].toSorted(),
    );
    // The emptied formula text goes with the renumbered id of its cell.
    expect(noted("renumbered")).toEqual(
      [
        `${CELLS}[@Col=3][@Row=5]/attributes/ExprID`,
        `${CELLS}[@Col=3][@Row=5]/children/0`,
        `${CELLS}[@Col=4][@Row=5]/attributes/ExprID`,
        `${CELLS}[@Col=4][@Row=5]/children/0`,
      ].toSorted(),
    );
    expect(noted("volatile")).toEqual([
      "/root/children/[name=meta]/attributes/saved",
      "/root/children/[name=meta]/attributes/session",
    ]);
    expect(noted("timestamp")).toEqual([
      "/root/children/[name=meta]/children/[name=date]/children/0",
    ]);
    // The edit leads, noise last.
    expect(file.values[0]?.note).toBeUndefined();
    expect(file.notes).toEqual([]);
  });

  it("keeps up to three noise checks, flagged in a note, when noise is all a document's change holds", () => {
    const file = xmlDraft(workbook(SEED), workbook({ ...SEED, cursor: "3" }));

    const kept = file.suggested.map(pointerOf);
    expect(kept).toHaveLength(3);
    for (const pointer of kept) expect(pointer).toContain(SELECTIONS);
    expect(file.notes).toEqual([
      expect.objectContaining({
        code: "view_state_only",
        file: "Documents/doc.xml",
        pointers: kept,
      }),
    ]);
  });

  it("demotes nothing in the app's own state, where a view setting may be the task", () => {
    const file = xmlDraft(workbook(SEED), workbook({ ...SEED, cursor: "3" }), {
      role: "application_state",
      file: ".config/sheets/state.xml",
    });

    expect(file.suggested.map(pointerOf)).toHaveLength(4);
    expect(file.values.filter((value) => "note" in value)).toEqual([]);
    expect(file.notes).toEqual([]);
  });

  it("keeps a document's geometry as content, since a CAD sketch's Geometry is what its user drew", () => {
    const sketch = (radius: string) =>
      `<Document><Object name="Sketch"><Geometry><Circle Radius="${radius}"/></Geometry></Object></Document>`;
    const file = xmlDraft(sketch("10"), sketch("12.5"));

    expect(file.suggested.map(pointerOf)).toEqual([
      "/root/children/[name=Object]/children/[name=Geometry]/children/[name=Circle]/attributes/Radius",
    ]);
    expect(file.values.filter((value) => value.note === "view_state")).toEqual(
      [],
    );
  });
});
