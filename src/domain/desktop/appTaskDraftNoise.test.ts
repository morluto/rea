import { describe, expect, it } from "vitest";

import type { JsonValue } from "../jsonValue.js";
import {
  draftOf,
  pointerOf,
  statePath,
  xml,
  xmlDraft,
} from "./appTaskDraft.fixture.js";

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

    expect(file.suggested.map(pointerOf)).toEqual([`${CELLS}[@Col=3][@Row=2]`]);
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

  it("keeps a formula edit when the cell's ExprID changes too", () => {
    const sheet = (march: string, formula: string, id: string) =>
      `<Workbook><Sheet><Cells><Cell Row="2" Col="3">${march}</Cell><Cell Row="5" Col="3" ExprID="${id}">${formula}</Cell></Cells></Sheet></Workbook>`;
    const file = xmlDraft(
      sheet("405.1", "=sum(C2:C4)", "2"),
      sheet("437.8", "=sum(C2:C5)", "4"),
    );
    const shown = file.suggested.flatMap((check) =>
      "value" in check && typeof check.value === "string" ? [check.value] : [],
    );

    expect(shown).toContain("=sum(C2:C5)");
    expect(
      file.values
        .filter(({ note }) => note === "renumbered")
        .map(({ pointer }) => pointer),
    ).toEqual([
      "/root/children/[name=Sheet]/children/[name=Cells]/children/[name=Cell][@Row=5]/attributes/ExprID",
    ]);
  });

  it("keeps an edit that follows more noise than a file has room for checks", () => {
    const cursors = (value: string) =>
      Array.from(
        { length: 12 },
        (_, index) => `cursor${String(index)}="${value}"`,
      ).join(" ");
    const shape = (cursor: string, width: string) =>
      `<doc><view ${cursors(cursor)}/><shape name="box" width="${width}"/></doc>`;

    const file = xmlDraft(shape("1", "10"), shape("2", "12"));

    expect(file.suggested).toEqual([
      {
        kind: "value_equals",
        file: "Documents/doc.xml",
        pointer: "/root/children/[name=shape]/attributes/width",
        value: "12",
      },
    ]);
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

  it("keeps every view-state check of the app's own state when it is all that changed, flagged, since a view setting may be the task", () => {
    const file = xmlDraft(workbook(SEED), workbook({ ...SEED, cursor: "3" }), {
      role: "application_state",
      file: ".config/sheets/state.xml",
    });

    const kept = file.suggested.map(pointerOf);
    expect(kept).toHaveLength(4);
    for (const pointer of kept) expect(pointer).toContain(SELECTIONS);
    expect(file.values.map(({ note }) => note)).toEqual(
      Array.from({ length: 4 }, () => "view_state"),
    );
    expect(file.notes).toEqual([
      expect.objectContaining({ code: "view_state_only", pointers: kept }),
    ]);
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

describe("draftTaskFiles noise named in values and metadata", () => {
  /** A spreadsheet saved as ODF keeps it: view and printer settings named by a `name` value, edit time and counts, a stamped header time. */
  const saved = (save: {
    duration: string;
    cycles: string;
    total: string;
    saves: string;
    cursor: string;
    printer: string;
    time: string;
    february: string;
    cleaning: string;
  }) =>
    `<document><meta><generator>Sheets 24.2</generator><editing-duration>${save.duration}</editing-duration><editing-cycles>${save.cycles}</editing-cycles><total-time>${save.total}</total-time><save-count>${save.saves}</save-count></meta><settings><item-set name="ooo:view-settings"><item name="CursorPositionX">${save.cursor}</item><item name="ActiveSplitRange">2</item></item-set><item-set name="ooo:configuration-settings"><item name="AutoCalculate">true</item><item name="PrinterName">${save.printer}</item></item-set></settings><header><time value="${save.time}">00:00:00</time></header><body><cell name="February">${save.february}</cell><cell name="Window cleaning">${save.cleaning}</cell></body></document>`;
  const SEED_SAVE = {
    duration: "PT1M42S",
    cycles: "1",
    total: "PT1M",
    saves: "1",
    cursor: "0",
    printer: "",
    time: "05:13:42.339510419",
    february: "21300",
    cleaning: "40",
  };
  const EDITED_SAVE = {
    duration: "PT2M2S",
    cycles: "2",
    total: "PT2M",
    saves: "2",
    cursor: "1",
    printer: "Generic Printer",
    time: "05:16:21.675302540",
    february: "23100",
    cleaning: "45",
  };

  it("demotes what a name-like value names as view state, edit time and counts under the metadata, and a time of day, but not a phrase a user named", () => {
    const file = xmlDraft(saved(SEED_SAVE), saved(EDITED_SAVE));

    const body = "/root/children/[name=body]/children/[name=cell]";
    expect(file.suggested.map(pointerOf)).toEqual([
      `${body}[@name=February]`,
      `${body}[@name=Window cleaning]`,
    ]);
    const noted = Object.fromEntries(
      file.values.map(({ pointer, note }) => [pointer, note ?? "edit"]),
    );
    const meta = "/root/children/[name=meta]/children";
    const settings = "/root/children/[name=settings]/children/[name=item-set]";
    expect(noted).toEqual({
      [`${body}[@name=February]/children/0`]: "edit",
      [`${body}[@name=Window cleaning]/children/0`]: "edit",
      [`${meta}/[name=editing-duration]/children/0`]: "view_state",
      [`${meta}/[name=editing-cycles]/children/0`]: "view_state",
      [`${meta}/[name=total-time]/children/0`]: "volatile",
      [`${meta}/[name=save-count]/children/0`]: "volatile",
      [`${settings}[@name=ooo:view-settings]/children/[name=item][@name=CursorPositionX]/children/0`]:
        "view_state",
      [`${settings}[@name=ooo:configuration-settings]/children/[name=item][@name=PrinterName]/children/0`]:
        "view_state",
      "/root/children/[name=header]/children/[name=time]/attributes/value":
        "timestamp",
    });
  });
});

describe("draftTaskFiles noise in the app's own state", () => {
  /** A note as Gnote keeps it: its text, the times it stamps and where the cursor was. */
  const note = (text: string, changed: string, cursor: string) =>
    `<note version="0.3"><title>Shopping List</title><text><note-content>${text}</note-content></text><last-change-date>${changed}</last-change-date><cursor-position>${cursor}</cursor-position></note>`;

  it("leaves the cursor and stamped times out of the suggestions when the note's text changed too, noting each in values", () => {
    const file = xmlDraft(
      note("Shopping List\n\neggs", "2026-11-06T04:52:36.702406Z", "19"),
      note(
        "Shopping List\n\neggs\nolive oil",
        "2026-11-06T04:54:17.918949Z",
        "78",
      ),
      { role: "application_state", file: ".local/share/gnote/list.note" },
    );

    expect(file.suggested.map(pointerOf)).toEqual([
      "/root/children/[name=text]/children/[name=note-content]",
    ]);
    expect(file.values.map(({ pointer, note: why }) => [pointer, why])).toEqual(
      [
        [
          "/root/children/[name=text]/children/[name=note-content]/children/0",
          undefined,
        ],
        ["/root/children/[name=last-change-date]/children/0", "timestamp"],
        ["/root/children/[name=cursor-position]/children/0", "view_state"],
      ],
    );
    expect(file.notes).toEqual([]);
  });
});

describe("draftTaskFiles upkeep in an archive", () => {
  const entry = (name: string, view: string) => ({
    name,
    size: view.length,
    sha256: view,
    format: "xml",
    view: xml(view),
    view_error: null,
  });
  const archive = (content: string, text: string, heading = text) => ({
    entries: [
      entry(
        "content.xml",
        `<office><body><p name="Title">${content}</p></body></office>`,
      ),
      entry(
        "styles.xml",
        `<styles><style name="Text">${text}</style><style name="Heading">${heading}</style></styles>`,
      ),
    ],
    entry_count: 2,
    truncated: false,
  });
  const drafted = (before: JsonValue, after: JsonValue) => {
    const [file] = draftOf({
      "Documents/flyer.odt": statePath("document", "zip", before, after),
    });
    if (file === undefined) throw new Error("the file did not change");
    return file;
  };
  const filled =
    "/entries/[name=styles.xml]/view/root/children/[name=style][@name=Text]/children/[name=props]/attributes/tab-stop";

  it("demotes an attribute several elements gained while another entry holds the edit", () => {
    const file = drafted(
      archive("Spring Sale", "<props/>"),
      archive("Summer Sale", `<props tab-stop="0in"/>`),
    );

    expect(file.suggested.map(pointerOf)).toEqual([
      "/entries/[name=content.xml]/view/root/children/[name=body]/children/[name=p]",
    ]);
    expect(file.values.find(({ pointer }) => pointer === filled)?.note).toBe(
      "upkeep",
    );
  });

  it("suggests an attribute an entry gained when nothing else changed, since that may be the edit", () => {
    const file = drafted(
      archive("Spring Sale", "<props/>"),
      archive("Spring Sale", `<props tab-stop="0in"/>`),
    );

    expect(file.suggested.map(pointerOf)).toEqual([
      filled,
      filled.replace("[@name=Text]", "[@name=Heading]"),
    ]);
    expect(file.values.map(({ note }) => note)).toEqual([undefined, undefined]);
  });

  it("keeps a font size added to one style when the document text changed too", () => {
    const file = drafted(
      archive("Spring Sale", "<props/>"),
      archive("Summer Sale", `<props font-size="12pt"/>`, "<props/>"),
    );
    const size =
      "/entries/[name=styles.xml]/view/root/children/[name=style][@name=Text]/children/[name=props]/attributes/font-size";

    expect(file.suggested.map(pointerOf)).toEqual([
      "/entries/[name=content.xml]/view/root/children/[name=body]/children/[name=p]",
      size,
    ]);
    expect(file.values.every(({ note }) => note === undefined)).toBe(true);
  });
});

describe("draftTaskFiles when a sibling lock changed", () => {
  const text = (line: string) => ({
    lines: [line],
    line_count: 1,
    truncated: false,
  });

  it("keeps the settings draft when the lock is the only document that changed", () => {
    const files = draftOf({
      ".config/app/settings.json": statePath(
        "application_state",
        "json",
        { size: 1 },
        { size: 2 },
      ),
      "Documents/plan.vym": statePath(
        "document",
        "text",
        text("map"),
        text("map"),
      ),
      "Documents/plan.vym.lock": statePath(
        "document",
        "text",
        text("lock"),
        text("held"),
      ),
    });
    const settings = files.find(
      (file) => file.file === ".config/app/settings.json",
    );

    expect(settings?.suggested).not.toEqual([]);
  });

  it("keeps the settings draft when the selected folder also contains the lock", () => {
    const marked = (
      role: "application_state" | "document",
      format: "json" | "text",
      before: { size: number } | ReturnType<typeof text>,
      after: { size: number } | ReturnType<typeof text>,
    ) => ({
      ...statePath(role, format, before, after),
      reasons: ["selected_path" as const],
    });
    const files = draftOf(
      {
        ".config/app/settings.json": marked(
          "application_state",
          "json",
          { size: 1 },
          { size: 2 },
        ),
        "Documents/plan.vym": marked(
          "document",
          "text",
          text("map"),
          text("map"),
        ),
        "Documents/plan.vym.lock": marked(
          "document",
          "text",
          text("lock"),
          text("held"),
        ),
      },
      ["Documents"],
    );
    const settings = files.find(
      (file) => file.file === ".config/app/settings.json",
    );

    expect(settings?.suggested).not.toEqual([]);
  });

  it("drafts a lock that was selected itself, beside the file it names", () => {
    const files = draftOf(
      {
        "Documents/plan.vym": statePath(
          "document",
          "text",
          text("map"),
          text("map"),
        ),
        "Documents/plan.vym.lock": statePath(
          "document",
          "text",
          text("lock"),
          text("held"),
        ),
      },
      ["Documents/plan.vym.lock"],
    );
    const lock = files.find((file) => file.file === "Documents/plan.vym.lock");

    expect(lock?.suggested).not.toEqual([]);
  });
});
