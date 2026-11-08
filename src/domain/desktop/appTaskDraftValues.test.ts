import { describe, expect, it } from "vitest";

import {
  draftOf,
  passing,
  pointerOf,
  statePath,
  xml,
  xmlDraft,
} from "./appTaskDraft.fixture.js";
import { draftValues } from "./appTaskDraftValues.js";
import { compactValue } from "./compactValue.js";
import { resolvePointer } from "./viewPointer.js";
import { zipEntry, zipView } from "./zipView.js";

it("cuts XML previews after escaping, including entity and surrogate boundaries", () => {
  const element = {
    name: "n",
    attributes: { value: '😀&<"' },
    children: ["a&<😀"],
  };
  const complete = '<n value="😀&amp;&lt;&quot;">a&amp;&lt;😀</n>';
  for (const limit of [
    0,
    1,
    10,
    11,
    12,
    17,
    25,
    complete.length,
    complete.length + 1,
  ])
    expect(compactValue(element, limit, "xml")).toBe(
      complete.length > limit ? `${complete.slice(0, limit)}…` : complete,
    );
  expect(
    compactValue(
      { name: "n", attributes: { value: "&".repeat(1_000_000) }, children: [] },
      600,
      "xml",
    ),
  ).toBe(`${('<n value="' + "&amp;".repeat(120)).slice(0, 600)}…`);
});

it("cuts JSON previews after escaping keys and values", () => {
  const value = { '😀"\n': ["a\n😀\\\ud800"] };
  const complete = JSON.stringify(value);
  for (let limit = 0; limit <= complete.length + 1; limit += 1)
    expect(compactValue(value, limit, "json")).toBe(
      complete.length > limit ? `${complete.slice(0, limit)}…` : complete,
    );
});

/** A household book: accounts, payees and categories by key, and operations naming them. */
const book = (operations: string, note = "Draft", tags = '<tag name="old"/>') =>
  `<book><account key="1" name="Everyday Checking"/><pay key="1" name="Fresh Market"/><pay key="2" name="Landlord"/><cat key="12" name="Rent"/><cat key="44" name="Groceries"/><ope wording="October rent" amount="-1450.00" account="1" payee="2" category="12"/>${operations}<note>${note}</note>${tags}</book>`;
const GROCERIES =
  '<ope wording="Weekly groceries" amount="-64.18" account="1" payee="1" category="44"/>';

describe("draftTaskFiles values", () => {
  it("lists each value the change added, changed and removed at the pointer a check names it by, with what it was and became", () => {
    const before = book("");
    const after = book(GROCERIES, "Final", "");

    const file = xmlDraft(before, after);

    expect(file.values_cut).toBe(false);
    // Text first, so no cut ever drops it.
    expect(file.values.map(({ pointer, kind }) => [kind, pointer])).toEqual([
      ["changed", "/root/children/[name=note]/children/0"],
      ["added", "/root/children/[name=ope][@wording=Weekly groceries]"],
      ["removed", "/root/children/[name=tag]"],
    ]);
    const [changed, added, removed] = file.values;
    expect(added).toMatchObject({ before: null, after: GROCERIES });
    expect(removed).toMatchObject({ before: '<tag name="old"/>', after: null });
    // A scalar's before and after are what its pointer reads at each end.
    expect(changed).toMatchObject({ before: "Draft", after: "Final" });
    expect(resolvePointer(xml(before), changed?.pointer ?? "")).toBe("Draft");
    expect(resolvePointer(xml(after), changed?.pointer ?? "")).toBe("Final");
  });

  it("resolves a value that is another element's key, by the attribute's stem where several share it", () => {
    const file = xmlDraft(book(""), book(GROCERIES));

    // account="1" and payee="1" both match a key 1; the attribute's stem picks the element.
    expect(file.values[0]?.refers_to).toEqual([
      {
        attribute: "account",
        value: "1",
        element: '<account key="1" name="Everyday Checking"/>',
      },
      {
        attribute: "payee",
        value: "1",
        element: '<pay key="1" name="Fresh Market"/>',
      },
      {
        attribute: "category",
        value: "44",
        element: '<cat key="44" name="Groceries"/>',
      },
    ]);
  });

  it("notes a value only position reaches, and cuts a long one at 600 characters", () => {
    const long = (letter: string) => letter.repeat(700);
    const file = xmlDraft(
      `<list><item><v>a</v></item><item><v>b</v></item><desc>${long("x")}</desc></list>`,
      `<list><item><v>a</v></item><item><v>c</v></item><desc>${long("y")}</desc></list>`,
    );

    expect(
      file.values.map(({ pointer, note }) => [pointer, note ?? null]),
    ).toEqual([
      ["/root/children/[name=desc]/children/0", null],
      ["/root/children/1/children/[name=v]/children/0", "by_position"],
    ]);
    const [cut] = file.values;
    expect(cut?.after).toBe(`${"y".repeat(600)}…`);
    expect(cut?.before).toBe(`${"x".repeat(600)}…`);
  });

  it("does not mark a JSON object key as by position when the path looks like an index", () => {
    const file = draftOf({
      "settings.json": statePath(
        "application_state",
        "json",
        { children: {} },
        { children: { "1": "later" } },
      ),
    })[0];
    const added = file?.values.find((value) => value.kind === "added");
    expect(added?.pointer).toBe("/children/1");
    expect(added?.note).toBeUndefined();
  });

  it("notes a run of text added or removed in mixed content as by position, since only its index reaches it", () => {
    const document = (lead: string) =>
      `<abiword><section><p xid="1" style="Normal">${lead}<c props="font-weight:bold">Budget</c> is due Friday.</p></section></abiword>`;
    const paragraph =
      "/root/children/[name=section]/children/[name=p]/children";

    const file = xmlDraft(document("Reminder: "), document(""));

    expect(
      file.values.map(({ kind, pointer, note }) => [kind, pointer, note]),
    ).toEqual([
      ["added", `${paragraph}/1`, "by_position"],
      ["removed", `${paragraph}/0`, "by_position"],
      ["removed", `${paragraph}/2`, "by_position"],
    ]);
  });

  it("lists at most 20 values and 8 KB a file and 24 KB a draft, saying when it left any out", () => {
    const items = (count: number, value: (index: number) => string) =>
      `<doc>${Array.from({ length: count }, (_, index) => `<p id="${String(index)}" v="${value(index)}"/>`).join("")}</doc>`;
    const many = xmlDraft(
      items(25, () => "a"),
      items(25, () => "b"),
    );
    expect([many.values.length, many.values_cut]).toEqual([20, true]);

    // Eight changes of 590 characters each overfill a file's 8 KB...
    const wide = (letter: string) => () => letter.repeat(590);
    const files = Object.fromEntries(
      ["a", "b", "c", "d", "e"].map((name) => [
        `Documents/${name}.xml`,
        statePath(
          "document",
          "xml",
          xml(items(8, wide("x"))),
          xml(items(8, wide("y"))),
        ),
      ]),
    );
    const drafted = draftOf(files);
    const bytes = (values: unknown) =>
      new TextEncoder().encode(JSON.stringify(values)).length;
    for (const file of drafted)
      expect(bytes(file.values)).toBeLessThanOrEqual(8 * 1024);
    expect(drafted[0]).toMatchObject({ values_cut: true });
    // ...and the draft's 24 KB runs out before the last file's.
    expect(
      drafted.reduce((sum, file) => sum + bytes(file.values), 0),
    ).toBeLessThanOrEqual(24 * 1024);
    expect(drafted.at(-1)?.values.length).toBeLessThan(
      drafted[0]?.values.length ?? 0,
    );
  });
});

it("preserves JSON objects whose keys resemble XML and archive views", () => {
  const xmlLike = {
    name: "Cell",
    attributes: {},
    children: ["437.8"],
    label: "keep me",
  };
  const archiveLike = {
    name: "book",
    sha256: "abc",
    view: {},
    label: "keep me",
  };
  const file = draftOf({
    "settings.json": statePath(
      "application_state",
      "json",
      {},
      { xmlLike, archiveLike },
    ),
  })[0];
  expect(
    file?.values.find(({ pointer }) => pointer === "/xmlLike")?.after,
  ).toBe(JSON.stringify(xmlLike));
  expect(
    file?.values.find(({ pointer }) => pointer === "/archiveLike")?.after,
  ).toBe(JSON.stringify(archiveLike));
});

it("uses the entry format for JSON within an archive", () => {
  const element = {
    name: "Cell",
    attributes: {},
    children: ["437.8"],
    label: "keep me",
  };
  const archive = (contents: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(contents));
    return zipView(
      [
        zipEntry(
          {
            name: "state.json",
            size: bytes.length,
            compressedSize: bytes.length,
            method: 8,
            encrypted: false,
          },
          bytes,
        ),
      ],
      1,
    );
  };
  const file = draftOf({
    "Documents/state.zip": statePath(
      "document",
      "zip",
      archive({}),
      archive({ element }),
    ),
  })[0];
  const value = file?.values.find(({ pointer }) =>
    pointer.endsWith("/view/element"),
  );
  expect(value?.after).toBe(JSON.stringify(element));
  expect(value?.refers_to).toBeUndefined();
});

it("keeps JSON archive edits whose keys resemble XML attributes", () => {
  const archive = (contents: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(contents));
    return zipView(
      [
        zipEntry(
          {
            name: "state.json",
            size: bytes.length,
            compressedSize: bytes.length,
            method: 8,
            encrypted: false,
          },
          bytes,
        ),
      ],
      1,
    );
  };
  const file = draftOf({
    "Documents/state.zip": statePath(
      "document",
      "zip",
      archive({ title: "old", attributes: { history: "first" } }),
      archive({ title: "new", attributes: { history: "second" } }),
    ),
  })[0];
  expect(file?.suggested).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "value_equals",
        pointer: "/entries/[name=state.json]/view/title",
        value: "new",
      }),
      expect.objectContaining({
        kind: "value_equals",
        pointer: "/entries/[name=state.json]/view/attributes/history",
        value: "second",
      }),
    ]),
  );
  expect(
    file?.values.find(({ pointer }) => pointer.endsWith("/attributes/history"))
      ?.note,
  ).toBeUndefined();
});

describe("draftTaskFiles values' text and references", () => {
  it("keeps the spaces the XML reader kept as text in an element's compact XML, and leaves out its layout", () => {
    const paragraph = "<p>Meet on <s>Sunday</s> <s>evening</s>.</p>";

    const file = xmlDraft(
      "<doc>\n  <title>Plans</title>\n</doc>",
      `<doc>\n  <title>Plans</title>\n  ${paragraph}\n</doc>`,
    );

    expect(file.values).toEqual([
      {
        pointer: "/root/children/[name=p]",
        kind: "added",
        before: null,
        after: paragraph,
      },
    ]);
  });

  it("resolves a key the records of many archive entries share in time that grows with the records, not with their square", () => {
    // Copying the key's list of elements for each record took four seconds for 60,000 here.
    const entry = (name: string, text: string) => {
      const bytes = new TextEncoder().encode(text);
      return zipEntry(
        {
          name,
          size: bytes.length,
          compressedSize: bytes.length,
          method: 8,
          encrypted: false,
        },
        bytes,
      );
    };
    const records = Array.from({ length: 200 }, (_, index) =>
      entry(
        `records/${String(index)}.xml`,
        `<records>${'<rec key="1"/>'.repeat(300)}</records>`,
      ),
    );
    const archive = (category: string) =>
      zipView(
        [
          entry(
            "book.xml",
            `<book><cat key="1" name="Rent"/><ope category="${category}"/></book>`,
          ),
          ...records,
        ],
        records.length + 1,
      );
    const ends = { baseline: archive("2"), final: archive("1") };
    const pointer =
      "/entries/[name=book.xml]/view/root/children/[name=ope]/attributes/category";

    const started = performance.now();
    const { values } = draftValues(
      {
        added: [],
        changed: [pointer],
        removed: [],
        added_count: 0,
        changed_count: 1,
        removed_count: 0,
      },
      {
        ends,
        listed: () => true,
        noise: () => undefined,
        format: () => "xml",
        referenceRoots: (view) => (view === null ? [] : [view]),
      },
    );
    const elapsed = performance.now() - started;

    expect(values[0]?.refers_to).toEqual([
      {
        attribute: "category",
        value: "1",
        element: '<cat key="1" name="Rent"/>',
      },
    ]);
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("draftTaskFiles change lists", () => {
  it("lists an XML file's change by the selectors naming its members, not their positions", () => {
    const file = xmlDraft(
      '<doc><p id="a">x</p><p id="b">y</p></doc>',
      '<doc><p id="new">z</p><p id="a">x</p><p id="b">w</p></doc>',
    );

    expect(file.change).toMatchObject({
      added: expect.arrayContaining(["/root/children/[name=p][@id=new]"]),
      changed: ["/root/children/[name=p][@id=b]/children/0"],
      removed: [],
    });
  });

  it("lists a change by position where only the members' order changed, and says why no check names it", () => {
    const file = xmlDraft(
      '<doc><p id="a"/><p id="b"/></doc>',
      '<doc><p id="b"/><p id="a"/></doc>',
    );

    expect(file.change).toMatchObject({
      changed: expect.arrayContaining(["/root/children/0/attributes/id"]),
    });
    expect(file.suggested).toEqual([]);
    expect(file.notes.map(({ code }) => code)).toEqual(["by_position"]);
  });
});

describe("draftTaskFiles values of a file created or deleted", () => {
  it("lists what a created file holds as added and a deleted one's as removed, each member of its outermost container once", () => {
    const doc = "<doc><title>Plans</title></doc>";
    const text = new TextEncoder().encode(doc);
    const archive = zipView(
      [
        zipEntry(
          {
            name: "content.xml",
            size: text.length,
            compressedSize: text.length,
            method: 8,
            encrypted: false,
          },
          text,
        ),
      ],
      1,
    );

    const files = draftOf({
      "Documents/new.xml": statePath("document", "xml", null, xml(doc)),
      "Documents/gone.xml": statePath("document", "xml", xml(doc), null),
      "Documents/new.json": statePath("document", "json", null, {
        title: "Plans",
        tags: ["a"],
      }),
      "Documents/gone.ini": statePath(
        "document",
        "keyfile",
        { groups: { View: { zoom: "2" } } },
        null,
      ),
      "Documents/new.zip": statePath("document", "zip", null, archive),
    });

    expect(
      Object.fromEntries(
        files.map(({ file, values, values_cut }) => [
          file,
          [
            values_cut,
            ...values.map(({ kind, pointer, before, after }) => [
              kind,
              pointer,
              before,
              after,
            ]),
          ],
        ]),
      ),
    ).toEqual({
      "Documents/gone.ini": [
        false,
        ["removed", "/groups/View/zoom", "2", null],
      ],
      "Documents/gone.xml": [false, ["removed", "/root", doc, null]],
      "Documents/new.json": [
        false,
        ["added", "/title", null, "Plans"],
        ["added", "/tags", null, '["a"]'],
      ],
      "Documents/new.xml": [false, ["added", "/root", null, doc]],
      "Documents/new.zip": [
        false,
        [
          "added",
          "/entries/[name=content.xml]",
          null,
          JSON.stringify({
            name: "content.xml",
            format: "xml",
            size: text.length,
          }),
        ],
      ],
    });
    // The checks stay those of the file's presence.
    expect(
      files.map(({ suggested }) => suggested.map(({ kind }) => kind)),
    ).toEqual([
      ["file_absent"],
      ["file_absent"],
      ["file_present"],
      ["file_present"],
      ["file_present"],
    ]);
  });

  it("keeps a created file's values within a file's limits, saying when it left any out", () => {
    const view = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [
        `k${String(index)}`,
        "x".repeat(700),
      ]),
    );

    const [file] = draftOf({
      "Documents/new.json": statePath("document", "json", null, view),
    });

    expect(file?.values_cut).toBe(true);
    expect(file?.values.length).toBeLessThanOrEqual(20);
    expect(file?.values[0]?.after).toBe(`${"x".repeat(600)}…`);
    expect(
      new TextEncoder().encode(JSON.stringify(file?.values)).length,
    ).toBeLessThanOrEqual(8 * 1024);
  });
});

describe("draftTaskFiles for a transaction added to a book, as GnuCash saves one", () => {
  const GROCERIES = "98f0ee4c216a43e290133637df088843";
  const CHECKING = "63fd8736eb444c57803945f330e68a28";
  const account = (name: string, id: string) =>
    `<gnc:account version="2.0.0"><act:name>${name}</act:name><act:id type="guid">${id}</act:id></gnc:account>`;
  const split = (id: string, value: string, to: string) =>
    `<trn:split><split:id type="guid">${id}</split:id><split:reconciled-state>n</split:reconciled-state><split:value>${value}</split:value><split:account type="guid">${to}</split:account></trn:split>`;
  /** A transaction: its id, currency, dates, description, a slot the app keeps and its splits. */
  const transaction = (
    [id, description, posted, entered]: readonly string[],
    splits: string,
  ) =>
    `<gnc:transaction version="2.0.0"><trn:id type="guid">${id ?? ""}</trn:id><trn:currency><cmdty:id>USD</cmdty:id></trn:currency><trn:date-posted><ts:date>${posted ?? ""}</ts:date></trn:date-posted><trn:date-entered><ts:date>${entered ?? ""}</ts:date></trn:date-entered><trn:description>${description ?? ""}</trn:description><trn:slots><slot><slot:key>date-posted</slot:key></slot></trn:slots><trn:splits>${splits}</trn:splits></gnc:transaction>`;
  const CORNER = transaction(
    [
      "1b4e2dae15ea45c5889105a7ae939e04",
      "Corner Grocer",
      "2026-10-16 10:59:00 +0000",
      "2026-11-06 08:49:09 +0000",
    ],
    split("0aa0a2a505ac40dd9c74f0abfe7e0ca1", "5275/100", GROCERIES) +
      split("954a27fff0ad4d54a9a6f26436a60c54", "-5275/100", CHECKING),
  );
  const greenleaf = (ids: readonly string[], entered: string) =>
    transaction(
      [ids[0] ?? "", "Greenleaf Market", "2026-11-03 10:59:00 +0000", entered],
      split(ids[1] ?? "", "6348/100", GROCERIES) +
        split(ids[2] ?? "", "-6348/100", CHECKING),
    );
  /** A book: options GnuCash fills on reopening, from control bytes to an id, its accounts and transactions. */
  const gnucash = (option: string, added: string, slots = "") =>
    `<gnc-v2 xmlns:gnc="g" xmlns:act="a" xmlns:trn="t" xmlns:split="s" xmlns:ts="ts" xmlns:cmdty="c" xmlns:slot="sl" xmlns:book="b"><gnc:book version="2.0.0"><book:slots><slot><slot:key>Default Customer TaxTable</slot:key><slot:value type="guid">${option}</slot:value></slot>${slots}</book:slots>${account("Groceries", GROCERIES)}${account("Checking Account", CHECKING)}${CORNER}${added}</gnc:book></gnc-v2>`;
  const SEED = gnucash("??\u007f", "");
  const END = gnucash(
    "99471669fefd47b7b6eb2131be4e6d00",
    greenleaf(
      [
        "a893ecc337254562a3b167b4534dc020",
        "c05c3906b2634257883cbf894462acc1",
        "d15c3906b2634257883cbf894462acc2",
      ],
      "2026-11-06 08:53:08 +0000",
    ),
    "<slot><slot:key>remove-color-not-set-slots</slot:key></slot>",
  );
  const TRANSACTION =
    "/root/children/[name=gnc:book]/children/[name=gnc:transaction][>trn:description=Greenleaf Market]";

  it("names the transaction by its description, checks what the user entered under it, counts the transactions, and suggests none of what the app stamps or keeps", () => {
    const file = xmlDraft(SEED, END);

    expect(
      file.suggested.map((check) => [
        check.kind,
        pointerOf(check)?.replace(TRANSACTION, "~"),
      ]),
    ).toEqual([
      ["text_equals", "~/children/[name=trn:date-posted]"],
      [
        "text_equals",
        "~/children/[name=trn:splits]/children/[name=trn:split][>split:value=6348~1100]/children/[name=split:account]",
      ],
      [
        "text_equals",
        "~/children/[name=trn:splits]/children/[name=trn:split][>split:value=-6348~1100]/children/[name=split:account]",
      ],
      ["member_count", "/root/children/[name=gnc:book]/children"],
    ]);
    // Another save of the same entry: new ids, another time entered.
    const later = gnucash(
      "11471669fefd47b7b6eb2131be4e6d01",
      greenleaf(
        [
          "b893ecc337254562a3b167b4534dc021",
          "e05c3906b2634257883cbf894462acc3",
          "f15c3906b2634257883cbf894462acc4",
        ],
        "2026-11-09 14:02:41 +0000",
      ),
    );
    expect(passing("Documents/doc.xml", xml(SEED), file.suggested)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(
      passing("Documents/doc.xml", xml(later), file.suggested).every(Boolean),
    ).toBe(true);
  });

  it("lists the transaction field by field and each split whole, naming the account a split's text refers to, and notes the app's ids, entry time and slots", () => {
    const file = xmlDraft(SEED, END);

    const listed = file.values.map(({ pointer, note, refers_to }) => [
      pointer.replace(TRANSACTION, "~"),
      note ?? null,
      refers_to?.map(({ element }) => element) ?? null,
    ]);
    expect(listed).toEqual(
      expect.arrayContaining([
        ["~/children/[name=trn:description]", null, null],
        [
          "~/children/[name=trn:splits]/children/[name=trn:split][>split:value=6348~1100]",
          null,
          ['<gnc:account version="2.0.0"><act:name>Groceries</act:name>…'],
        ],
        [
          "~/children/[name=trn:splits]/children/[name=trn:split][>split:value=-6348~1100]",
          null,
          [
            '<gnc:account version="2.0.0"><act:name>Checking Account</act:name>…',
          ],
        ],
        ["~/children/[name=trn:id]", "volatile", null],
        ["~/children/[name=trn:date-entered]", "timestamp", null],
        ["~/children/[name=trn:slots]/children/[name=slot]", "upkeep", null],
      ]),
    );
    const slots = file.values.filter(({ pointer }) =>
      pointer.includes("[name=book:slots]"),
    );
    expect(slots.map(({ note }) => note)).toEqual(["upkeep", "upkeep"]);
  });
});

describe("draftTaskFiles for a transaction added to a book, as KMyMoney saves one", () => {
  /** A split of a transaction: its id, which KMyMoney numbers anew in every transaction, amount, account and payee. */
  const split = (id: string, value: string, account: string, payee: string) =>
    `<SPLIT value="${value}" shares="${value}" memo="" account="${account}" price="1/1" id="${id}" payee="${payee}" reconcileflag="0"/>`;
  const transaction = (id: string, date: string, splits: string) =>
    `<TRANSACTION memo="" entrydate="2026-11-06" postdate="${date}" id="${id}" commodity="USD"><SPLITS>${splits}</SPLITS></TRANSACTION>`;
  const WATER = transaction(
    "T000000000000000001",
    "2026-10-12",
    split("S0001", "-209/5", "A000001", "P000002") +
      split("S0002", "209/5", "A000011", "P000002"),
  );
  const ELECTRIC = transaction(
    "T000000000000000002",
    "2026-10-20",
    split("S0001", "-921/10", "A000001", "P000003") +
      split("S0002", "921/10", "A000011", "P000003"),
  );
  const PAYMENT = transaction(
    "T000000000000000003",
    "2026-11-03",
    split("S0001", "-1749/20", "A000001", "P000003") +
      split("S0002", "1749/20", "A000011", "P000003"),
  );
  /** A book: a file version whose id is a small number, payees, accounts the institution and parent list by id, and transactions. */
  const kmy = (count: string, added: string) =>
    `<KMYMONEY-FILE><FILEINFO><FIXVERSION id="3"/></FILEINFO><INSTITUTION id="I000001" name="Maple Grove Credit Union"><ACCOUNTIDS><ACCOUNTID id="A000001"/></ACCOUNTIDS></INSTITUTION><PAYEES><PAYEE id="P000002" name="Northside Water Co."/><PAYEE id="P000003" name="Riverside Electric"/></PAYEES><ACCOUNTS><ACCOUNT id="AStd::Expense" name="Expense"><SUBACCOUNTS><SUBACCOUNT id="A000011"/></SUBACCOUNTS></ACCOUNT><ACCOUNT id="A000001" name="Household Checking"/><ACCOUNT id="A000011" name="Utilities"/></ACCOUNTS><TRANSACTIONS count="${count}">${WATER}${ELECTRIC}${added}</TRANSACTIONS></KMYMONEY-FILE>`;
  const SEED = kmy("2", "");
  const END = kmy("3", PAYMENT);
  const SPLITS =
    "/root/children/[name=TRANSACTIONS]/children/[name=TRANSACTION][@postdate=2026-11-03]/children/[name=SPLITS]/children";

  it("checks each split of the new transaction by the account it names, its amount and payee, not by the split id every transaction repeats", () => {
    const file = xmlDraft(SEED, END);

    const field = (account: string, key: string, value: string) => ({
      kind: "value_equals",
      file: "Documents/doc.xml",
      pointer: `${SPLITS}/[name=SPLIT][@account=${account}]/attributes/${key}`,
      value,
    });
    // `shares` repeats `value` in every split, and `memo`, `price` and `reconcileflag` are alike in all.
    expect(file.suggested.slice(0, 4)).toEqual([
      field("A000001", "value", "-1749/20"),
      field("A000001", "payee", "P000003"),
      field("A000011", "value", "1749/20"),
      field("A000011", "payee", "P000003"),
    ]);
    const checks = file.suggested.slice(0, 4);
    expect(passing("Documents/doc.xml", xml(SEED), checks)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(passing("Documents/doc.xml", xml(END), checks)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    // A wrong amount fails.
    const wrong = END.replace('value="1749/20"', 'value="1700/20"');
    expect(passing("Documents/doc.xml", xml(wrong), checks)).toEqual([
      true,
      true,
      false,
      true,
    ]);
  });

  it("names the account and payee each split refers to, the account over an id list naming it too, and no element a plain count equals", () => {
    const file = xmlDraft(SEED, END);

    const added = file.values.find(({ kind }) => kind === "added");
    expect(
      added?.refers_to?.map(({ attribute, value, element }) => [
        attribute,
        value,
        element,
      ]),
    ).toEqual([
      [
        "account",
        "A000001",
        '<ACCOUNT id="A000001" name="Household Checking"/>',
      ],
      ["payee", "P000003", '<PAYEE id="P000003" name="Riverside Electric"/>'],
      ["account", "A000011", '<ACCOUNT id="A000011" name="Utilities"/>'],
    ]);
    // count="3" equals FIXVERSION's id, but `count` names no element.
    const count = file.values.find(({ pointer }) =>
      pointer.endsWith("/attributes/count"),
    );
    expect(count).toMatchObject({ before: "2", after: "3" });
    expect(count?.refers_to).toBeUndefined();
  });

  it("checks a split moved to a new account, though its value equals the id the new account took, so a solve that never moves it fails", () => {
    const opened = (seed: string) =>
      seed
        .replace(
          '<SUBACCOUNT id="A000011"/>',
          '<SUBACCOUNT id="A000011"/><SUBACCOUNT id="A000012"/>',
        )
        .replace(
          '<ACCOUNT id="A000011" name="Utilities"/>',
          '<ACCOUNT id="A000011" name="Utilities"/><ACCOUNT id="A000012" name="Water"/>',
        );
    const moved = opened(SEED).replace(
      'account="A000011" price="1/1" id="S0002" payee="P000002"',
      'account="A000012" price="1/1" id="S0002" payee="P000002"',
    );
    const file = xmlDraft(SEED, moved);

    const account = file.values.find(
      ({ pointer, after }) =>
        pointer.endsWith("/attributes/account") && after === "A000012",
    );
    expect(account).toBeDefined();
    expect(account?.note).toBeUndefined();
    expect(
      passing("Documents/doc.xml", xml(moved), file.suggested),
    ).not.toContain(false);
    // Opening the account alone leaves the water bill where it was.
    expect(
      passing("Documents/doc.xml", xml(opened(SEED)), file.suggested),
    ).toContain(false);
  });
});

describe("draftTaskFiles values' other pointers", () => {
  it("lists a changed value's pointer by each other name its element holds alone, as an Inkscape text's label beside its id", () => {
    const poster = (headline: string) =>
      `<svg xmlns:inkscape="i"><text id="text12" inkscape:label="Headline" x="10"><tspan>${headline}</tspan></text><text id="text14" inkscape:label="Venue" x="10"><tspan>Pier 4</tspan></text></svg>`;

    const file = xmlDraft(poster("Jazz Night"), poster("Jazz Festival"));

    const [changed] = file.values;
    expect(changed).toMatchObject({
      pointer:
        "/root/children/[name=text][@id=text12]/children/[name=tspan]/children/0",
      after: "Jazz Festival",
      alternatives: [
        "/root/children/[name=text][@inkscape:label=Headline]/children/[name=tspan]/children/0",
      ],
    });
    // Each reads the same value at the end.
    expect(
      resolvePointer(
        xml(poster("Jazz Festival")),
        changed?.alternatives?.[0] ?? "",
      ),
    ).toBe("Jazz Festival");
  });
});

describe("draftTaskFiles values in an archive's entries", () => {
  it("lists a chapter title's pointer by the id its h1 holds, though its tag alone names it", () => {
    const chapter = (title: string) =>
      `<html><body><h1 id="chapter-two">${title}</h1><p>The supply boat brought one letter.</p></body></html>`;
    const epub = (title: string) => {
      const entry = zipEntry(
        {
          name: "OEBPS/Text/Section0002.xhtml",
          size: 1,
          compressedSize: 1,
          method: 8,
          encrypted: false,
        },
        new TextEncoder().encode(chapter(title)),
      );
      return zipView([entry], 1);
    };
    const [file] = draftOf({
      "Documents/book.epub": statePath(
        "document",
        "zip",
        epub("A Letter from the Mainlnad"),
        epub("A Letter from the Mainland"),
      ),
    });

    const h1 =
      "/entries/[name=OEBPS~1Text~1Section0002.xhtml]/view/root/children/[name=body]/children/[name=h1]";
    expect(file?.values[0]).toMatchObject({
      pointer: `${h1}/children/0`,
      alternatives: [
        "/entries/[name=OEBPS~1Text~1Section0002.xhtml]/view/root/children/[name=body]/children/[name=h1][@id=chapter-two]/children/0",
      ],
    });
  });
});
