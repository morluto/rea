import { describe, expect, it } from "vitest";

import type { DesktopTaskCheckInput } from "./appTask.js";
import { evaluateTaskChecks } from "./appTaskChecks.js";
import { passing, xml, xmlDraft } from "./appTaskDraft.fixture.js";

const FILE = "Documents/doc.xml";

describe("draftTaskFiles for elements no attribute names", () => {
  /** A score whose title frame holds untitled texts, as MuseScore 3 saves one, each with its style or none. */
  const score = (title: string, composer: string, styled = true) => {
    const text = (style: string, value: string) =>
      `<Text>${styled ? `<style>${style}</style>` : ""}<text>${value}</text></Text>`;
    return `<museScore><Score><Staff><VBox><height>10</height>${text("Title", title)}${text("Composer", composer)}</VBox><Measure><Chord>C</Chord></Measure></Staff></Score></museScore>`;
  };
  const FRAME =
    "/root/children/[name=Score]/children/[name=Staff]/children/[name=VBox]";

  it("checks the whole text of the nearest ancestor its tag names, within three levels", () => {
    const before = score("Morning Song", "Theo Ashby", false);
    const after = score("Evening Lullaby", "Clara Hollis", false);

    const file = xmlDraft(before, after);

    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer: FRAME,
        value: "10Evening LullabyClara Hollis",
      },
    ]);
    expect(passing(FILE, xml(before), file.suggested)).toEqual([false]);
    expect(passing(FILE, xml(after), file.suggested)).toEqual([true]);
  });

  it("checks each text by the child that names it, as MuseScore's by its style, rather than the frame's whole text", () => {
    const before = score("Morning Song", "Theo Ashby");
    const after = score("Evening Lullaby", "Clara Hollis");

    const file = xmlDraft(before, after);

    expect(file.suggested).toEqual(
      [
        ["Title", "Evening Lullaby"],
        ["Composer", "Clara Hollis"],
      ].map(([style, value]) => ({
        kind: "text_equals",
        file: FILE,
        pointer: `${FRAME}/children/[name=Text][>style=${style}]/children/[name=text]`,
        value,
      })),
    );
    expect(passing(FILE, xml(before), file.suggested)).toEqual([false, false]);
    expect(passing(FILE, xml(after), file.suggested)).toEqual([true, true]);
  });

  /** An address book of records with no attributes, as Osmo keeps its contacts. */
  const contacts = (...records: string[]) =>
    `<osmo_contacts><contacts_records>${records
      .map(
        (fields) =>
          `<record><group>None</group>${fields}<birthday_date>0</birthday_date></record>`,
      )
      .join("")}</contacts_records></osmo_contacts>`;
  const HANNAH =
    "<first_name>Hannah</first_name><last_name>Okafor</last_name><email_1>hannah.okafor@example.com</email_1>";
  const DELPHINE =
    "<first_name>Delphine</first_name><last_name>Moreau</last_name><cell_phone_1>555-0163</cell_phone_1><email_1>delphine.moreau@example.com</email_1>";

  it("names a record added whole by a child's text and checks each field it entered, never a default every record holds, then counts the records", () => {
    const before = contacts(HANNAH);
    const after = contacts(HANNAH, DELPHINE);

    const file = xmlDraft(before, after, {
      role: "application_state",
      file: ".local/share/osmo/contacts.xml",
    });

    const list = "/root/children/[name=contacts_records]";
    const record = `${list}/children/[name=record][>first_name=Delphine]`;
    // Not "None" or "0", every record's, nor the first name that names it.
    expect(file.suggested).toEqual([
      ...[
        ["last_name", "Moreau"],
        ["cell_phone_1", "555-0163"],
        ["email_1", "delphine.moreau@example.com"],
      ].map(([field, value]) => ({
        kind: "text_equals",
        file: ".local/share/osmo/contacts.xml",
        pointer: `${record}/children/[name=${field}]`,
        value,
      })),
      {
        kind: "member_count",
        file: ".local/share/osmo/contacts.xml",
        pointer: `${list}/children`,
        matching: "[name=record]",
        equals: 2,
      },
    ]);
    const file_ = ".local/share/osmo/contacts.xml";
    expect(passing(file_, xml(before), file.suggested)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(passing(file_, xml(after), file.suggested).every(Boolean)).toBe(
      true,
    );
  });

  it("skips an added record's identifier and stamped date, and notes a field past the text limit", () => {
    const home = ".local/share/osmo/contacts.xml";
    const essay = "N".repeat(2001);
    const book = (records: string) =>
      `<osmo_contacts><contacts_records>${records}</contacts_records></osmo_contacts>`;
    const kept =
      "<record><group>None</group><first_name>Hannah</first_name></record>";
    const before = book(kept);
    const after = book(
      `${kept}<record><id>124</id><first_name>Delphine</first_name><mdate><year>2026</year><month>11</month><day>7</day></mdate><note>${essay}</note></record>`,
    );
    const file = xmlDraft(before, after, {
      role: "application_state",
      file: home,
    });
    const values = file.suggested.flatMap((check) =>
      "value" in check && typeof check.value === "string" ? [check.value] : [],
    );
    expect(values.some((value) => value.includes("Delphine"))).toBe(true);
    expect(values).not.toContain("124");
    expect(values).not.toContain("2026");
    expect(values.some((value) => value.includes(essay))).toBe(false);
    expect(file.notes.map(({ code }) => code)).toContain("long_text");
  });
});

describe("draftTaskFiles for a named record that also holds a save time", () => {
  it("checks the edited field, not the record text that joins the timestamp", () => {
    const box = (value: string, modified: string) =>
      `<doc><box name="other"><value>Keep</value><modified>2026-11-01T10:12:00Z</modified></box><box name="target"><value>${value}</value><modified>${modified}</modified></box></doc>`;
    const before = box("Old", "2026-11-07T10:12:00Z");
    const saved = box("New", "2026-11-07T10:12:00Z");
    const restamped = box("New", "2026-11-08T09:00:00Z");
    const file = xmlDraft(before, saved);
    const values = file.suggested.flatMap((check) =>
      "value" in check && typeof check.value === "string" ? [check.value] : [],
    );
    expect(values.some((value) => value.includes("2026-11-07T10:12:00Z"))).toBe(
      false,
    );
    expect(values).toContain("New");
    expect(passing(FILE, xml(restamped), file.suggested).every(Boolean)).toBe(
      true,
    );
  });

  it("checks the paragraph, which a later save keeps, when the new text sits in a run beside a save time", () => {
    const box = (inner: string, modified: string) =>
      `<doc><box name="target"><body><p>${inner}</p></body><modified>${modified}</modified></box></doc>`;
    const before = box("<span>Old</span>", "2026-11-07T10:12:00Z");
    const saved = box("<span>New</span>", "2026-11-07T10:12:00Z");
    const unwrapped = box("New", "2026-11-08T09:00:00Z");
    const file = xmlDraft(before, saved);

    expect(
      file.suggested.flatMap((check) =>
        "pointer" in check ? [check.pointer] : [],
      ),
    ).toEqual([
      "/root/children/[name=box]/children/[name=body]/children/[name=p]",
    ]);
    expect(passing(FILE, xml(unwrapped), file.suggested).every(Boolean)).toBe(
      true,
    );
  });
});

describe("draftTaskFiles for a record removed whole", () => {
  const contacts = (...names: string[]) =>
    `<osmo_contacts><contacts_records>${names
      .map(
        (name) =>
          `<record><group>None</group><first_name>${name}</first_name><birthday_date>0</birthday_date></record>`,
      )
      .join("")}</contacts_records></osmo_contacts>`;

  it("checks the record a child names is gone, and the records' count", () => {
    const before = contacts("Hannah", "Delphine");
    const after = contacts("Hannah");

    const file = xmlDraft(before, after, {
      role: "application_state",
      file: ".local/share/osmo/contacts.xml",
    });

    const list = "/root/children/[name=contacts_records]";
    expect(file.suggested).toMatchObject([
      {
        kind: "value_absent",
        pointer: `${list}/children/[name=record][>first_name=Delphine]`,
      },
      { kind: "member_count", pointer: `${list}/children`, equals: 1 },
    ]);
    const home = ".local/share/osmo/contacts.xml";
    expect(
      [before, after, contacts("Delphine")].map((text) =>
        passing(home, xml(text), file.suggested),
      ),
    ).toEqual([
      [false, false],
      [true, true],
      [false, true],
    ]);
  });
});

describe("draftTaskFiles for records whatever their fields are called", () => {
  it("names a record of repeated <field> children by a field's text and checks its whole text, in a list at the root", () => {
    const records = (...people: [string, string][]) =>
      `<records>${people
        .map(
          ([first, last]) =>
            `<record><field>${first}</field><field>${last}</field></record>`,
        )
        .join("")}</records>`;
    const before = records(["Hannah", "Okafor"]);
    const after = records(["Hannah", "Okafor"], ["Delphine", "Moreau"]);

    const file = xmlDraft(before, after);

    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer: "/root/children/[name=record][>field=Delphine]",
        value: "DelphineMoreau",
      },
      {
        kind: "member_count",
        file: FILE,
        pointer: "/root/children",
        matching: "[name=record]",
        equals: 2,
      },
    ]);
    expect(
      [before, after].map((text) => passing(FILE, xml(text), file.suggested)),
    ).toEqual([
      [false, false],
      [true, true],
    ]);
  });

  it("checks the name inside a nested field and leaves its save time out", () => {
    const records = (extra: string) =>
      `<records><record><field>Hannah</field></record>${extra}</records>`;
    const added = `<record><details><name>Delphine</name><modified>2026-11-07T10:12:00Z</modified></details></record>`;
    const before = records("");
    const after = records(added);
    const restamped = records(
      added.replace("2026-11-07T10:12:00Z", "2026-11-08T09:00:00Z"),
    );
    const file = xmlDraft(before, after);
    const values = file.suggested.flatMap((check) =>
      check.kind === "text_contains" ? [check.value] : [],
    );

    expect(values).toEqual(["Delphine"]);
    expect(passing(FILE, xml(restamped), file.suggested).every(Boolean)).toBe(
      true,
    );
  });

  it("checks each name around a nested save time, not the two names joined", () => {
    const records = (extra: string) =>
      `<records><record><field>Hannah</field></record>${extra}</records>`;
    const added = `<record><details><name>Delphine</name><modified>2026-11-07T10:12:00Z</modified><name>Moreau</name></details></record>`;
    const file = xmlDraft(records(""), records(added));
    const values = file.suggested.flatMap((check) =>
      check.kind === "text_contains" ? [check.value] : [],
    );

    expect(values).toEqual(["Delphine", "Moreau"]);
    expect(
      passing(FILE, xml(records(added)), file.suggested).every(Boolean),
    ).toBe(true);
  });

  it("suggests no check a cut view leaves undecided for a record only position names, added before the cut", () => {
    const book = (...people: string[]) =>
      `<book><contacts>${people
        .map(
          (name) =>
            `<record><field>${name}</field><field>Okafor</field></record>`,
        )
        .join(
          "",
        )}</contacts><log>${"<entry>x</entry>".repeat(2600)}</log></book>`;
    const before = book("Hannah", "Bo");
    const after = book("Hannah", "Bo", "Delphine");
    const outcomes = (text: string, checks: readonly DesktopTaskCheckInput[]) =>
      evaluateTaskChecks(
        checks.map((check, index) => ({ ...check, id: `c${String(index)}` })),
        new Map([[FILE, { format: "xml" as const, view: xml(text) }]]),
      ).map(({ passed, undecided }) => [passed, undecided === true]);

    const file = xmlDraft(before, after);

    expect(xml(after)).toMatchObject({ truncated: true });
    // The record is reported as only position reaching it, not dropped.
    expect(file.notes.map(({ code }) => code)).toEqual([
      "cut_view",
      "by_position",
    ]);
    // Each suggestion decides at both ends: failing at the seed, passing at the end.
    expect(outcomes(before, file.suggested)).toEqual(
      file.suggested.map(() => [false, false]),
    );
    expect(outcomes(after, file.suggested)).toEqual(
      file.suggested.map(() => [true, false]),
    );
  });

  it("checks a <link> field of a record a selector names, beside its other fields, though the record holds a save date", () => {
    const stamp = `<mdate><year>2026</year><month>11</month><day>06</day></mdate>`;
    const bookmarks = (...entries: [string, string, string][]) =>
      `<bookmarks>${entries
        .map(
          ([id, title, link]) =>
            `<bookmark id="${id}"><title>${title}</title><link>${link}</link>${stamp}</bookmark>`,
        )
        .join("")}</bookmarks>`;
    const docs: [string, string, string] = [
      "1",
      "Docs",
      "https://example.com/docs",
    ];
    const before = bookmarks(docs);
    const after = bookmarks(docs, [
      "2",
      "Release notes",
      "https://example.com/notes",
    ]);

    const file = xmlDraft(before, after);

    const bookmark = "/root/children/[name=bookmark][@id=2]";
    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer: `${bookmark}/children/[name=title]`,
        value: "Release notes",
      },
      {
        kind: "text_equals",
        file: FILE,
        pointer: `${bookmark}/children/[name=link]`,
        value: "https://example.com/notes",
      },
      {
        kind: "member_count",
        file: FILE,
        pointer: "/root/children",
        matching: "[name=bookmark]",
        equals: 2,
      },
    ]);
  });
});

describe("draftTaskFiles for an identified record's own text", () => {
  it("checks the text of repeated unnamed fields", () => {
    const records = (people: readonly (readonly [string, string, string])[]) =>
      `<doc><records>${people
        .map(
          ([id, first, last]) =>
            `<record id="${id}"><field>${first}</field><field>${last}</field></record>`,
        )
        .join("")}</records></doc>`;
    const before = records([["one", "Ada", "Lovelace"]]);
    const after = records([
      ["one", "Ada", "Lovelace"],
      ["two", "Delphine", "Moreau"],
    ]);
    const file = xmlDraft(before, after);
    const shown = file.suggested.flatMap((check) =>
      "value" in check && typeof check.value === "string" ? [check.value] : [],
    );

    expect(shown).toEqual(["Delphine", "Moreau"]);
    expect(
      file.suggested.some(
        (check) => "value" in check && check.value === "record",
      ),
    ).toBe(false);
    expect(passing(FILE, xml(after), file.suggested).every(Boolean)).toBe(true);
    expect(passing(FILE, xml(before), file.suggested).every(Boolean)).toBe(
      false,
    );
  });

  it("checks a phone number and a clock time a person entered", () => {
    const people = (extra: string) =>
      `<doc><records><record id="one"><name>Ada</name></record>${extra}</records></doc>`;
    const before = people("");
    const after = people(
      `<record id="two"><name>Delphine</name><phone>2025550163</phone><meet>09:30:00</meet></record>`,
    );
    const file = xmlDraft(before, after);
    const shown = file.suggested.flatMap((check) =>
      "value" in check && typeof check.value === "string" ? [check.value] : [],
    );

    expect(shown).toContain("2025550163");
    expect(shown).toContain("09:30:00");
    expect(passing(FILE, xml(before), file.suggested).some(Boolean)).toBe(
      false,
    );
  });
});

describe("draftTaskFiles for an added record whose words the seed already has", () => {
  const list = (people: readonly (readonly [string, string])[]) =>
    `<records>${people
      .map(
        ([first, last]) =>
          `<record><field>${first}</field><field>${last}</field></record>`,
      )
      .join("")}</records>`;

  it("checks the list text when every new field repeats a word the seed has", () => {
    const before = list([["Ada", "Lin"]]);
    const after = list([
      ["Ada", "Lin"],
      ["Lin", "Ada"],
    ]);
    const file = xmlDraft(before, after);

    expect(file.suggested.map(({ kind }) => kind)).toContain("text_equals");
    expect(passing(FILE, xml(before), file.suggested).every(Boolean)).toBe(
      false,
    );
    expect(passing(FILE, xml(after), file.suggested).every(Boolean)).toBe(true);
  });

  it("does not check a long list whole when the added record only repeats its words", () => {
    const people = Array.from(
      { length: 80 },
      () => ["NorthwindHouse", "QuillPublisher"] as const,
    );
    const before = list(people);
    const after = list([...people, ["QuillPublisher", "NorthwindHouse"]]);
    const file = xmlDraft(before, after);

    expect(file.suggested.some(({ kind }) => kind === "text_equals")).toBe(
      false,
    );
    expect(
      file.suggested.some(
        (check) =>
          "value" in check &&
          (check.value === "NorthwindHouse" ||
            check.value === "QuillPublisher"),
      ),
    ).toBe(false);
  });
});

describe("draftTaskFiles for a paragraph made of runs", () => {
  /** A Writer document's body: a paragraph, and any added after it. */
  const body = (added: string) =>
    `<office:document-content xmlns:office="urn:office" xmlns:text="urn:text" xmlns:xlink="urn:xlink"><office:body><office:text><text:p>Plan for Monday</text:p>${added}</office:text></office:body></office:document-content>`;
  const meeting = (day: string) =>
    `<text:p><text:span>Meet </text:span><text:a xlink:href="#${day}">${day}</text:a></text:p>`;

  it("checks a new paragraph of runs of different tags by its text, as text rather than a record of fields", () => {
    const before = body("");
    const after = body(meeting("Monday"));

    const file = xmlDraft(before, after);

    // The text the paragraph sits in, whole: no word of it by itself.
    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer:
          "/root/children/[name=office:body]/children/[name=office:text]",
        value: "Plan for MondayMeet Monday",
      },
    ]);
    // The seed's text already holds Monday, so a paragraph naming another day must fail a check.
    expect(
      passing(FILE, xml(body(meeting("Tuesday"))), file.suggested),
    ).toContain(false);
    expect(passing(FILE, xml(after), file.suggested).every(Boolean)).toBe(true);
  });

  it("checks a Word paragraph's whole text where an edit appends a run of elements beside a kept run, not the run as a record", () => {
    const paragraph = (runs: string) =>
      `<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Meeting at </w:t></w:r>${runs}</w:p></w:body></w:document>`;
    const bold = (text: string) =>
      `<w:r><w:rPr><w:b/></w:rPr><w:t>${text}</w:t></w:r>`;

    const file = xmlDraft(paragraph(""), paragraph(bold("3:30")));

    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer: "/root/children/[name=w:body]/children/[name=w:p]",
        value: "Meeting at 3:30",
      },
    ]);
    expect(
      [bold("3:30"), bold("13:30")].map((runs) =>
        passing(FILE, xml(paragraph(runs)), file.suggested),
      ),
    ).toEqual([[true], [false]]);
  });

  it("checks a list's whole text where an edit appends an item that only formats its text, which a wrong item fails", () => {
    const list = (items: string) =>
      `<note><text><note-content><list><list-item>bread</list-item><list-item>eggs</list-item>${items}</list></note-content></text></note>`;
    const item = (text: string) =>
      `<list-item><bold>${text}</bold></list-item>`;

    const file = xmlDraft(list(""), list(item("olive oil")));

    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer:
          "/root/children/[name=text]/children/[name=note-content]/children/[name=list]",
        value: "breadeggsolive oil",
      },
    ]);
    expect(
      [item("olive oil"), item("no olive oil")].map((items) =>
        passing(FILE, xml(list(items)), file.suggested),
      ),
    ).toEqual([[true], [false]]);
  });
});

describe("draftTaskFiles for an element added to a list", () => {
  const ledger = (operations: string) =>
    `<homebank><settings theme="light"/>${operations}</homebank>`;
  const RENT =
    '<ope date="739900" amount="-1450.00" account="1" category="12" flags="0" wording="October rent"/>';

  it("checks each attribute of the new member, best ranked first, leaving out its selector, identifiers, times and volatile values", () => {
    const groceries =
      '<ope name="groceries" id="1325" date="739924" amount="-64.18" account="1" category="44" flags="0" created="2026-11-04T10:00:00Z" uuid="0b5c1f0e-3c1d-4f7a-9a3e-2d7f5b8c9e10" wording="Weekly groceries"/>';

    const file = xmlDraft(ledger(RENT), ledger(RENT + groceries));

    const check = (
      key: string,
      value: string | number,
      tolerance?: number,
    ) => ({
      kind: "value_equals",
      file: FILE,
      pointer: `/root/children/[name=ope][@name=groceries]/attributes/${key}`,
      value,
      ...(tolerance === undefined ? {} : { tolerance }),
    });
    expect(file.suggested).toEqual([
      check("wording", "Weekly groceries"),
      check("account", "1"),
      check("category", "44"),
      check("flags", "0"),
      check("date", "739924"),
      // A decimal the app writes as text is checked by its number.
      check("amount", -64.18, 0.001),
      {
        kind: "member_count",
        file: FILE,
        pointer: "/root/children",
        matching: "[name=ope]",
        equals: 2,
      },
    ]);
  });

  it("checks at most six attributes, and an element with no like sibling by its presence", () => {
    const wide = `<ope ${["a", "b", "c", "d", "e", "f", "g", "h"]
      .map((key) => `${key}="value ${key}"`)
      .join(" ")} wording="Weekly groceries"/>`;
    const added = xmlDraft(ledger(RENT), ledger(RENT + wide));
    expect(
      added.suggested.filter(({ kind }) => kind === "value_equals"),
    ).toHaveLength(6);

    const alone = xmlDraft(ledger(""), ledger('<budget year="2026"/>'));
    expect(alone.suggested).toEqual([
      {
        kind: "value_equals",
        file: FILE,
        pointer: "/root/children/[name=budget]/name",
        value: "budget",
      },
    ]);
  });
});

describe("draftTaskFiles for a transaction appended to a Grisbi file", () => {
  /** Transactions as Grisbi writes them: attributes only, numbered by `Nb`, every `Id` the placeholder `(null)`. */
  const accounts = (
    ...rows: (readonly [string, string, string, string, string])[]
  ) =>
    `<Grisbi>${rows
      .map(
        ([nb, date, amount, party, category]) =>
          `<Transaction Ac="1" Nb="${nb}" Id="(null)" Dt="${date}" Cu="1" Am="${amount}" Exb="0" Pa="${party}" Ca="${category}" Sca="8" No="(null)" Ma="0" />`,
      )
      .join("")}<Party Nb="4" Na="Clearwater Utilities" /></Grisbi>`;
  const KEPT = [
    ["1", "10/02/2026", "-1150.00", "1", "18"],
    ["2", "10/05/2026", "-86.40", "2", "6"],
    ["3", "09/21/2026", "-41.30", "4", "18"],
  ] as const;

  it("names the new transaction by its number, not the placeholder id every one holds, and checks what was entered before the defaults", () => {
    const before = accounts(...KEPT);
    const after = accounts(...KEPT, ["4", "10/21/2026", "-58.75", "4", "18"]);

    const file = xmlDraft(before, after);

    const at = (key: string) =>
      `/root/children/[name=Transaction][@Nb=4]/attributes/${key}`;
    expect(file.suggested.slice(0, 4)).toEqual([
      { kind: "value_equals", file: FILE, pointer: at("Pa"), value: "4" },
      { kind: "value_equals", file: FILE, pointer: at("Ca"), value: "18" },
      {
        kind: "value_equals",
        file: FILE,
        pointer: at("Dt"),
        value: "10/21/2026",
      },
      {
        kind: "value_equals",
        file: FILE,
        pointer: at("Am"),
        value: -58.75,
        tolerance: 0.001,
      },
    ]);
    expect(file.suggested.at(-1)).toMatchObject({
      kind: "member_count",
      equals: 4,
    });
    expect(file.notes).toEqual([]);
    expect(passing(FILE, xml(before), file.suggested)).not.toContain(true);
    expect(passing(FILE, xml(after), file.suggested).every(Boolean)).toBe(true);
  });
});

describe("draftTaskFiles for decimals near a seed the evaluator reads as a number", () => {
  it("suggests no check by number that the seed's value, as `10` or `1e1`, already passes", () => {
    for (const seed of ["10", "1e1"]) {
      const value = (text: string) =>
        `<doc><total>${text}</total><note>x</note></doc>`;

      const file = xmlDraft(value(seed), value("10.0005"));

      expect(file.suggested).not.toEqual([]);
      expect(passing(FILE, xml(value(seed)), file.suggested)).not.toContain(
        true,
      );
      expect(
        passing(FILE, xml(value("10.0005")), file.suggested).every(Boolean),
      ).toBe(true);
    }
  });
});

describe("draftTaskFiles for decimals", () => {
  it("checks a decimal the app writes as text by its number within 0.001, unless the seed's is that close too", () => {
    const shape = (x: string, y: string, size: string) =>
      `<doc><shape name="logo" x="${x}" y="${y}" size="${size}"/></doc>`;

    const file = xmlDraft(
      shape("146.83", "10.5", "12"),
      shape("150.25", "10.5000001", "14"),
    );

    const logo = "/root/children/[name=shape]";
    expect(file.suggested).toEqual([
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${logo}/attributes/x`,
        value: 150.25,
        tolerance: 0.001,
      },
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${logo}/attributes/y`,
        value: "10.5000001",
      },
      // An integer stays the string it is.
      {
        kind: "value_equals",
        file: FILE,
        pointer: `${logo}/attributes/size`,
        value: "14",
      },
    ]);
  });

  it("checks a decimal by the element's whole text, so a save that splits the same digits across a run passes", () => {
    const cell = (inner: string) =>
      `<Cells><Cell Row="2" Col="3">${inner}</Cell><Cell Row="2" Col="4">1</Cell></Cells>`;
    const before = cell("405.1");
    const after = cell("437.8");
    const file = xmlDraft(before, after);

    expect(
      passing(FILE, xml(cell("437.<span>8</span>")), file.suggested),
    ).toEqual([true]);
    expect(passing(FILE, xml(cell("437.89")), file.suggested)).toEqual([false]);
  });

  it("checks a decimal so it fails at a seed whose integer is within the tolerance of it", () => {
    const sheet = (rate: string) =>
      `<Cells><Cell Row="2" Col="3">${rate}</Cell><Cell Row="3" Col="3">5</Cell></Cells>`;
    const before = sheet("0");
    const after = sheet("0.0005");

    const file = xmlDraft(before, after);

    expect(file.suggested).toHaveLength(1);
    expect(
      [before, after].map((text) => passing(FILE, xml(text), file.suggested)),
    ).toEqual([[false], [true]]);
  });
});

describe("draftTaskFiles for records in a list, as Tellico keeps books", () => {
  /** A book collection: field definitions, then entries by id, each stamped with the day it was made and changed, in parts. */
  const books = (...entries: string[]) =>
    `<tellico><collection title="My Books"><fields><field name="title" title="Title"/></fields>${entries.join("")}</collection></tellico>`;
  const stamp = (tag: string, day: string) =>
    `<${tag} calendar="gregorian"><year>2026</year><month>11</month><day>${day}</day></${tag}>`;
  const book = (
    id: string,
    [title, author, publisher, year]: readonly string[],
    [made, changed]: readonly [string, string] = ["06", "06"],
  ) =>
    `<entry id="${id}"><title>${title ?? ""}</title><authors><author>${author ?? ""}</author></authors><publisher>${publisher ?? ""}</publisher><pub_year>${year ?? ""}</pub_year><id>${id}</id>${stamp("cdate", made)}${stamp("mdate", changed)}</entry>`;
  const LANTERN = ["The Lantern Keeper", "Mira Okonkwo", "Quill Books", "2019"];
  const SALT = ["Salt Roads", "Tomas Lindqvist", "Northwind House", "2015"];
  const ORCHARD = [
    "The Glass Orchard",
    "Aurelio Benn",
    "Northwind House",
    "2022",
  ];
  const entry = (id: string) =>
    `/root/children/[name=collection]/children/[name=entry][@id=${id}]`;

  it("checks each field of a record appended to the list by the id it was given, never the list's whole text or the dates the app stamps", () => {
    const before = books(book("1", LANTERN), book("2", SALT));
    const after = books(
      book("1", LANTERN),
      book("2", SALT),
      book("3", ORCHARD),
    );

    const file = xmlDraft(before, after);

    // Field by field, so no cut hides one; the id and the dates the app stamps last.
    expect(file.values.map(({ pointer, note }) => [pointer, note])).toEqual([
      ...["title", "authors", "publisher", "pub_year", "id"].map((field) => [
        `${entry("3")}/children/[name=${field}]`,
        undefined,
      ]),
      [`${entry("3")}/children/[name=cdate]`, "timestamp"],
      [`${entry("3")}/children/[name=mdate]`, "timestamp"],
    ]);
    expect(file.suggested).toEqual([
      ...["title", "authors", "publisher", "pub_year"].map((field, index) => ({
        kind: "text_equals",
        file: FILE,
        pointer: `${entry("3")}/children/[name=${field}]`,
        value: ORCHARD[index],
      })),
      {
        kind: "member_count",
        file: FILE,
        pointer: "/root/children/[name=collection]/children",
        matching: "[name=entry]",
        equals: 3,
      },
    ]);
    // The same edit saved on another day passes too.
    const later = books(
      book("1", LANTERN),
      book("2", SALT),
      book("3", ORCHARD, ["09", "09"]),
    );
    expect(
      [before, after, later].map((text) =>
        passing(FILE, xml(text), file.suggested),
      ),
    ).toEqual([
      [false, false, false, false, false],
      [true, true, true, true, true],
      [true, true, true, true, true],
    ]);
  });

  it("checks a date a user enters in parts, as a birthday, as any other edit, since no tag names it bookkeeping", () => {
    const people = (day: string) =>
      `<people><person id="1"><name>Ada</name><birthday><year>1990</year><month>05</month><day>${day}</day></birthday></person><person id="2"><name>Bo</name><birthday><year>1985</year><month>01</month><day>02</day></birthday></person></people>`;
    const before = people("12");
    const after = people("14");

    const file = xmlDraft(before, after);

    expect(file.values).toEqual([
      {
        pointer:
          "/root/children/[name=person][@id=1]/children/[name=birthday]/children/[name=day]/children/0",
        kind: "changed",
        before: "12",
        after: "14",
      },
    ]);
    expect(file.suggested).not.toEqual([]);
    expect(
      [before, after].map((text) => passing(FILE, xml(text), file.suggested)),
    ).toEqual([
      file.suggested.map(() => false),
      file.suggested.map(() => true),
    ]);
    expect(file.notes).toEqual([]);
  });

  it("notes a date stamped in parts as a timestamp, never a check, and checks an edit beside it by the field it changed", () => {
    const before = books(book("1", LANTERN), book("2", SALT));
    const renamed = ["Salt Road", ...SALT.slice(1)];

    const edited = xmlDraft(
      before,
      books(book("1", LANTERN), book("2", renamed, ["06", "07"])),
    );
    const restamped = xmlDraft(
      before,
      books(book("1", LANTERN), book("2", SALT, ["06", "07"])),
    );

    // The field itself, not the record whose text would join its other fields.
    expect(edited.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer: `${entry("2")}/children/[name=title]`,
        value: "Salt Road",
      },
    ]);
    expect(
      edited.values.map(({ pointer, note }) => [pointer, note ?? null]),
    ).toEqual([
      [`${entry("2")}/children/[name=title]/children/0`, null],
      [
        `${entry("2")}/children/[name=mdate]/children/[name=day]/children/0`,
        "timestamp",
      ],
    ]);
    expect(restamped.suggested).toEqual([]);
    expect(restamped.notes.map(({ code }) => code)).toEqual([
      "view_state_only",
    ]);
  });
});
