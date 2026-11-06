import { describe, expect, it } from "vitest";

import { passing, xml, xmlDraft } from "./appTaskDraft.fixture.js";

const FILE = "Documents/doc.xml";

describe("draftTaskFiles for elements no attribute names", () => {
  /** A score whose title frame holds untitled texts, as MuseScore 3 saves one. */
  const score = (title: string, composer: string) =>
    `<museScore><Score><Staff><VBox><height>10</height><Text><style>Title</style><text>${title}</text></Text><Text><style>Composer</style><text>${composer}</text></Text></VBox><Measure><Chord>C</Chord></Measure></Staff></Score></museScore>`;

  it("checks the whole text of the nearest ancestor its tag names, within three levels", () => {
    const before = score("Morning Song", "Theo Ashby");
    const after = score("Evening Lullaby", "Clara Hollis");

    const file = xmlDraft(before, after);

    expect(file.suggested).toEqual([
      {
        kind: "text_equals",
        file: FILE,
        pointer:
          "/root/children/[name=Score]/children/[name=Staff]/children/[name=VBox]",
        value: "10TitleEvening LullabyComposerClara Hollis",
      },
    ]);
    expect(passing(FILE, xml(before), file.suggested)).toEqual([false]);
    expect(passing(FILE, xml(after), file.suggested)).toEqual([true]);
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

  it("checks each new field of a record added whole, each absent from the list's text at the seed, beside the list's whole text", () => {
    const before = contacts(HANNAH);
    const after = contacts(HANNAH, DELPHINE);

    const file = xmlDraft(before, after, {
      role: "application_state",
      file: ".local/share/osmo/contacts.xml",
    });

    const list = "/root/children/[name=contacts_records]";
    expect(
      file.suggested.map((check) => [
        check.kind,
        "pointer" in check ? check.pointer : undefined,
      ]),
    ).toEqual([
      ["text_equals", list],
      ["text_contains", list],
      ["text_contains", list],
      ["text_contains", list],
      ["text_contains", list],
    ]);
    // Not "None" or "0": the seed's text already holds them.
    expect(
      file.suggested.flatMap((check) =>
        check.kind === "text_contains" ? [check.value] : [],
      ),
    ).toEqual([
      "Delphine",
      "Moreau",
      "555-0163",
      "delphine.moreau@example.com",
    ]);
    const file_ = ".local/share/osmo/contacts.xml";
    expect(passing(file_, xml(before), file.suggested)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(passing(file_, xml(after), file.suggested).every(Boolean)).toBe(
      true,
    );
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
    ]);
  });

  it("checks at most six attributes, and an element with no like sibling by its presence", () => {
    const wide = `<ope ${["a", "b", "c", "d", "e", "f", "g", "h"]
      .map((key) => `${key}="value ${key}"`)
      .join(" ")} wording="Weekly groceries"/>`;
    const added = xmlDraft(ledger(RENT), ledger(RENT + wide));
    expect(added.suggested).toHaveLength(6);

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
});
