import { describe, expect, it } from "vitest";

import { draftOf, statePath } from "./appTaskDraft.fixture.js";
import { textView } from "./stateFormats.js";
import { evaluateTaskChecks } from "./appTaskChecks.js";

const FILE = "Documents/trip.txt";

/** A text file's lines, as a mind map exported to text keeps topics with the ids and times the app assigns. */
const lines = (...added: string[]) =>
  [
    "# Weekend Trip",
    'topic TEXT="Packing" ID="ID_1965352635"',
    'topic TEXT="Sleeping bags" ID="ID_1227863932" CREATED="1793955122470"',
    ...added,
    "</topic>",
    "</map>",
  ].join("\n");

const drafted = (before: string, after: string) => {
  const [file] = draftOf({
    [FILE]: statePath("document", "text", textView(before), textView(after)),
  });
  if (file === undefined) throw new Error("the file did not change");
  return file;
};

describe("draftTaskFiles for lines holding values the app generates", () => {
  it("checks a reference number in ordinary text", () => {
    const line = "Reference: ABC_123456";
    const file = drafted("# Instructions", `# Instructions\n${line}`);
    expect(file.suggested).toEqual([
      { kind: "lines_present", file: FILE, lines: [line] },
    ]);
    const checks = file.suggested.map((check, index) => ({
      ...check,
      id: `c${index}`,
    }));
    expect(
      evaluateTaskChecks(
        checks,
        new Map([
          [
            FILE,
            {
              format: "text",
              view: textView("# Instructions\nReference: WRONG"),
            },
          ],
        ]),
      ).map(({ passed }) => passed),
    ).toEqual([false]);
  });
  it("keeps an unquoted assignment in ordinary prose exact", () => {
    const line = "Set created=2025550123 and save";
    const file = drafted("# Instructions", `# Instructions\n${line}`);
    expect(file.suggested).toEqual([
      { kind: "lines_present", file: FILE, lines: [line] },
    ]);
    const checks = file.suggested.map((check, index) => ({
      ...check,
      id: `c${index}`,
    }));
    const wrong = new Map([
      [
        FILE,
        {
          format: "text" as const,
          view: textView("# Instructions\nSet created=WRONG and save"),
        },
      ],
    ]);
    expect(
      evaluateTaskChecks(checks, wrong).map(({ passed }) => passed),
    ).toEqual([false]);
  });
  it("keeps assignment-like text quoted in a translation", () => {
    const translation = 'msgstr "Set created=2025550123 and save"';
    const file = drafted(lines(), lines(translation));
    expect(file.suggested).toEqual([
      { kind: "lines_present", file: FILE, lines: [translation] },
    ]);
  });

  it("keeps quoted ID-like text exact", () => {
    const line = 'msgstr "Enter ID_329023692"';
    const file = drafted('msgid "Enter"', `msgid "Enter"\n${line}`);
    expect(file.suggested).toEqual([
      { kind: "lines_present", file: FILE, lines: [line] },
    ]);
    const checks = file.suggested.map((check, index) => ({
      ...check,
      id: `c${index}`,
    }));
    const wrong = new Map([
      [
        FILE,
        {
          format: "text" as const,
          view: textView('msgid "Enter"\nmsgstr "Enter WRONG"'),
        },
      ],
    ]);
    expect(
      evaluateTaskChecks(checks, wrong).map(({ passed }) => passed),
    ).toEqual([false]);
  });

  it("keeps an escaped quote inside ordinary text", () => {
    const translation = 'msgstr "Set \\\"created=2025550123 and save"';
    const file = drafted('msgid "Hello"', `msgid "Hello"\n${translation}`);
    expect(file.suggested).toEqual([
      { kind: "lines_present", file: FILE, lines: [translation] },
    ]);
  });
});

describe("draftTaskFiles for XML text views", () => {
  it("checks an XML text fallback without freezing a timestamp after a literal backslash", () => {
    const opening = '<!DOCTYPE map [<!ENTITY title "Map">]>\n<map>\n';
    const node = (time: string) =>
      `<node TEXT="C:\\work\\" CREATED="${time}"/>`;
    const before = `${opening}</map>`;
    const after = `${opening}${node("1793955250671")}\n</map>`;
    const file = drafted(before, after);
    const results = evaluateTaskChecks(
      file.suggested.map((check, index) => ({ ...check, id: `c${index}` })),
      new Map([
        [
          FILE,
          {
            format: "text" as const,
            view: textView(`${opening}${node("1793955259999")}\n</map>`),
          },
        ],
      ]),
    );
    expect(file.suggested).toEqual([
      expect.objectContaining({
        kind: "line_count",
        contains: '<node TEXT="C:\\work\\" CREATED="',
      }),
    ]);
    expect(results.map(({ passed }) => passed)).toEqual([true]);
  });

  it("keeps quoted CDATA as an exact requested line", () => {
    const opening = '<!DOCTYPE map [<!ENTITY title "Map">]>\n<map>\n';
    const line =
      '<text><![CDATA[msgstr "Set \\\"created=2025550123 and save"]]></text>';
    const file = drafted(`${opening}</map>`, `${opening}${line}\n</map>`);
    expect(file.suggested).toEqual([
      { kind: "lines_present", file: FILE, lines: [line] },
    ]);
    const altered = line.replace("2025550123", "WRONG");
    const results = evaluateTaskChecks(
      file.suggested.map((check, index) => ({ ...check, id: `c${index}` })),
      new Map([
        [
          FILE,
          {
            format: "text" as const,
            view: textView(`${opening}${altered}\n</map>`),
          },
        ],
      ]),
    );
    expect(results.map(({ passed }) => passed)).toEqual([false]);
  });

  it("keeps requested text inside a multiline XML attribute exact", () => {
    const opening = '<!DOCTYPE map [<!ENTITY title "Map">]>\n<map>\n';
    const text = 'created=2025550123 and save"/>';
    const file = drafted(
      `${opening}</map>`,
      `${opening}<node TEXT="Set\n${text}\n</map>`,
    );
    expect(file.suggested).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "lines_present",
          lines: expect.arrayContaining([text]),
        }),
      ]),
    );
    const result = evaluateTaskChecks(
      file.suggested.map((check, index) => ({ ...check, id: `c${index}` })),
      new Map([
        [
          FILE,
          {
            format: "text" as const,
            view: textView(
              `${opening}<node TEXT="Set\n${text.replace("2025550123", "WRONG")}\n</map>`,
            ),
          },
        ],
      ]),
    );
    expect(result.some(({ passed }) => !passed)).toBe(true);
  });

  it("recognizes an attribute on a later line of an XML tag", () => {
    const opening = '<!DOCTYPE map [<!ENTITY title "Map">]>\n<map>\n<node\n';
    const attribute = 'TEXT="C:\\work\\" CREATED="1793955250671"/>';
    const file = drafted(`${opening}</map>`, `${opening}${attribute}\n</map>`);
    expect(file.suggested).toEqual([
      expect.objectContaining({
        kind: "line_count",
        contains: 'TEXT="C:\\work\\" CREATED="',
      }),
    ]);
  });
});

describe("draftTaskFiles for markup boundaries and incomplete XML", () => {
  it("keeps quoted text after a Markdown autolink", () => {
    const line =
      '<https://example.test> msgstr "Set \\\"created=2025550123 and save"';
    const file = drafted("# Note", `# Note\n${line}`);
    expect(file.suggested).toEqual([
      { kind: "lines_present", file: FILE, lines: [line] },
    ]);
  });

  it("recognizes attributes after a comment inside the DTD", () => {
    const opening = "<!DOCTYPE map [<!-- author's note -->]>\n<map>\n";
    const node = '<node TEXT="C:\\work\\" CREATED="1793955250671"/>';
    const file = drafted(`${opening}</map>`, `${opening}${node}\n</map>`);
    expect(file.suggested).toEqual([
      expect.objectContaining({
        kind: "line_count",
        contains: '<node TEXT="C:\\work\\" CREATED="',
      }),
    ]);
  });

  it("counts repeated new lines even when one is inside an XML comment", () => {
    const opening = '<!DOCTYPE map [<!ENTITY title "Map">]>\n<map>\n';
    const node = '<node TEXT="C:\\work\\" CREATED="1793955250671"/>';
    const file = drafted(
      `${opening}</map>`,
      `${opening}<!--\n${node}\n-->\n${node}\n</map>`,
    );
    expect(file.suggested).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "line_count",
          contains: '<node TEXT="C:\\work\\" CREATED="',
          equals: 2,
        }),
      ]),
    );
    const results = evaluateTaskChecks(
      file.suggested.map((check, index) => ({ ...check, id: `c${index}` })),
      new Map([
        [
          FILE,
          {
            format: "text" as const,
            view: textView(`${opening}<!--\n${node}\n-->\n</map>`),
          },
        ],
      ]),
    );
    expect(results.some(({ passed }) => !passed)).toBe(true);
  });

  it("does not guess attribute boundaries when the XML syntax reader cannot finish", () => {
    const opening = '<!DOCTYPE map [<!ENTITY title "Map">]>\n<map>&title;\n';
    const node = '<node TEXT="C:\\work\\" CREATED="1793955250671"/>';
    const file = drafted(`${opening}</map>`, `${opening}${node}\n</map>`);
    expect(file.suggested).toEqual([]);
    expect(file.notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "read_as_text",
          message: expect.stringContaining("could not locate XML attributes"),
        }),
      ]),
    );
  });
});

describe("draftTaskFiles for added lines", () => {
  it("recognizes Unicode XML names before a malformed closing tag", () => {
    const opening = "<máp>\n";
    const node = '<node TEXT="C:\\work\\" CREATED="1793955250671"/>';
    const file = drafted(`${opening}</máp>`, `${opening}${node}\n</wrong>`);
    expect(file.suggested).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "line_count",
          contains: '<node TEXT="C:\\work\\" CREATED="',
        }),
      ]),
    );
  });

  it("requires the exact caller-supplied UUID in ordinary text", () => {
    const line = "Tracking id: 123e4567-e89b-12d3-a456-426614174000";
    const file = drafted("# Notes", `# Notes\n${line}`);
    expect(file.suggested).toEqual([
      { kind: "lines_present", file: FILE, lines: [line] },
    ]);
    const results = evaluateTaskChecks(
      file.suggested.map((check, index) => ({ ...check, id: `c${index}` })),
      new Map([
        [
          FILE,
          {
            format: "text" as const,
            view: textView("# Notes\nTracking id: WRONG"),
          },
        ],
      ]),
    );
    expect(results.map(({ passed }) => passed)).toEqual([false]);
  });

  it("retains parsed attribute positions before a malformed closing tag", () => {
    const opening = "<map>\n";
    const node = '<node TEXT="C:\\work\\" CREATED="1793955250671"/>';
    const file = drafted(`${opening}</map>`, `${opening}${node}\n</wrong>`);
    expect(file.suggested).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "line_count",
          contains: '<node TEXT="C:\\work\\" CREATED="',
        }),
      ]),
    );
  });

  it.each([
    "https://example.test",
    "ada@example.test",
    "mailto:ada@example.test",
  ])("keeps ordinary Markdown that begins with an autolink %s", (link) => {
    const opening = `<${link}>\n`;
    const line = 'msgstr "Set \\\"created=2025550123 and save"';
    const file = drafted(opening, `${opening}${line}`);
    expect(file.suggested).toEqual([
      { kind: "lines_present", file: FILE, lines: [line] },
    ]);
  });

  it("keeps long ordinary text as a whole line", () => {
    const text = `msgstr "${"ordinary words ".repeat(3000)}"`;
    const file = drafted(lines(), lines(text));
    expect(file.suggested).toEqual([
      { kind: "lines_present", file: FILE, lines: [text] },
    ]);
  });
  it("keeps assignment-like text exact when no XML structure identifies metadata", () => {
    const phone = 'topic TEXT="Call 2025550123"';
    const timed = 'topic TEXT="Water filter" CREATED="1793955250671"';
    const file = drafted(lines(), lines(phone, timed));
    expect(file.suggested).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "lines_present",
          lines: [phone, timed],
        }),
      ]),
    );
  });
  it("keeps a non-XML line with ID-like assignments exact", () => {
    const file = drafted(
      lines(),
      lines(
        'topic TEXT="Water filter" ID="ID_329023692" CREATED="1793955250671" MODIFIED="1793955252979"',
      ),
    );

    expect(file.suggested).toEqual([
      {
        kind: "lines_present",
        file: FILE,
        lines: [
          'topic TEXT="Water filter" ID="ID_329023692" CREATED="1793955250671" MODIFIED="1793955252979"',
        ],
      },
    ]);
    expect(file.notes).toEqual([]);
  });

  it("keeps an ID-like token without a generated ID field", () => {
    const line = "ID_329023692 1793955250671";
    const file = drafted(lines(), lines(line));
    expect(file.suggested).toEqual([
      { kind: "lines_present", file: FILE, lines: [line] },
    ]);
  });

  it("guards a kept line beside a new one, never a lone closing tag any such file holds", () => {
    const file = drafted(lines(), lines("Water filter"));

    expect(file.guards).toEqual([
      {
        kind: "lines_present",
        file: FILE,
        lines: [
          'topic TEXT="Packing" ID="ID_1965352635"',
          'topic TEXT="Sleeping bags" ID="ID_1227863932" CREATED="1793955122470"',
        ],
      },
    ]);
  });
});

describe("draftTaskFiles for lines added to a text file longer than its view", () => {
  it("counts no lines a view cut short, since a count there is undecided", () => {
    // Both views keep the first 5,000 lines of 5,001 or more, the new line among them.
    const long = (...added: string[]) =>
      [
        ...added,
        ...Array.from({ length: 5001 }, (_, index) => `line ${String(index)}`),
      ].join("\n");

    const file = drafted(
      long(),
      long(
        'topic TEXT="Water filter" ID="ID_329023692" CREATED="1793955250671"',
      ),
    );

    expect(file.change).toMatchObject({ complete: false });
    expect(file.suggested.map(({ kind }) => kind)).not.toContain("line_count");
  });
});

describe("draftTaskFiles guards of a document of commands and text, as LyX saves one", () => {
  /** A LyX body: each heading and paragraph opened by a command and closed by `\end_layout`. */
  const report = (heading: string) =>
    [
      "\\begin_body",
      "",
      "\\begin_layout Section",
      "Introduction",
      "\\end_layout",
      "",
      "\\begin_layout Standard",
      "This report summarises the spring season.",
      "\\end_layout",
      "",
      "\\begin_layout Section",
      heading,
      "\\end_layout",
      "",
      "\\begin_layout Standard",
      "Volunteers spread compost in early March.",
      "\\end_layout",
      "",
      "\\begin_layout Section",
      "Harvest Results",
      "\\end_layout",
      "",
      "\\end_body",
    ].join("\n");
  const doc = (heading: string) => {
    const view = textView(report(heading));
    return { view, file: "Documents/garden-report.lyx" };
  };

  it("guards the other headings the same command opens, never a command line or one every section repeats", () => {
    const [seed, end] = [doc("Soil Preperation"), doc("Soil Preparation")];
    const [file] = draftOf({
      [seed.file]: statePath("document", "text", seed.view, end.view),
    });

    expect(file?.suggested).toEqual([
      { kind: "lines_present", file: seed.file, lines: ["Soil Preparation"] },
      { kind: "lines_absent", file: seed.file, lines: ["Soil Preperation"] },
    ]);
    expect(file?.guards).toEqual([
      {
        kind: "lines_present",
        file: seed.file,
        lines: ["Introduction", "Harvest Results"],
      },
    ]);
  });
});

describe("draftTaskFiles guards of lines with no text of their own", () => {
  it("guards a text file's nearest lines with words, never a key alone, as a RedNotebook day's `24:`, nor a tag alone, as `<fonts>`", () => {
    const journal = (twentieth: string) =>
      [
        "20:",
        "  text: Repotted the basil and the rosemary on the balcony. The rosemary roots had",
        `    circled the whole pot.${twentieth}`,
        "24:",
        "  text: Cycled to the farmers market with Priya.",
        "<fonts>",
        "</fonts>",
      ].join("\n");
    const file = ".rednotebook/data/2026-10.txt";
    const [drafted] = draftOf({
      [file]: statePath(
        "application_state",
        "text",
        textView(journal("")),
        textView(journal(" Moved the rosemary to the sunny corner.")),
      ),
    });

    expect(drafted?.guards).toEqual([
      {
        kind: "lines_present",
        file,
        lines: [
          "  text: Repotted the basil and the rosemary on the balcony. The rosemary roots had",
          "  text: Cycled to the farmers market with Priya.",
        ],
      },
    ]);
  });
});

describe("draftTaskFiles for the app's log beside its journal", () => {
  it("drafts an app log and notes a text file that opens like XML but is not", () => {
    const lines = (...text: string[]) => textView(text.join("\n"));
    const files = draftOf({
      ".rednotebook/data/2026-10.txt": statePath(
        "application_state",
        "text",
        lines("20:", "  text: Repotted the basil."),
        lines("20:", "  text: Repotted the basil. Moved the rosemary."),
      ),
      ".rednotebook/rednotebook.log": statePath(
        "application_state",
        "text",
        lines("2026-11-06 15:11:21,847 DEBUG    Cloud updated"),
        lines(
          "2026-11-06 15:11:21,847 DEBUG    Cloud updated",
          "2026-11-06 15:11:50,559 INFO     Wrote file /home/user/.rednotebook/data/2026-10.txt",
        ),
      ),
      ".config/app/state.xml": statePath(
        "application_state",
        "text",
        lines("<!DOCTYPE state [<!ENTITY e 'x'>]>", "<state>&e;</state>"),
        lines("<!DOCTYPE state [<!ENTITY e 'x'>]>", "<state>&e;!</state>"),
      ),
    });

    const byFile = new Map(files.map((file) => [file.file, file]));
    expect(byFile.get(".rednotebook/rednotebook.log")?.suggested).not.toEqual(
      [],
    );
    expect(byFile.get(".rednotebook/data/2026-10.txt")?.suggested).not.toEqual(
      [],
    );
    expect(
      byFile.get(".config/app/state.xml")?.notes.map(({ code }) => code),
    ).toEqual(["read_as_text"]);
  });

  it("drafts a log the caller selected, and does not call a quoted bracket an entity subset", () => {
    const lines = (...text: string[]) => textView(text.join("\n"));
    const selected = {
      ...statePath(
        "application_state",
        "text",
        lines("opened"),
        lines("opened", "saved"),
      ),
      reasons: ["selected_path" as const],
    };
    const logged = draftOf({ ".config/app/notes.log": selected }, [
      ".config/app/notes.log",
    ]);
    const noted = draftOf({
      "Documents/state.txt": statePath(
        "document",
        "text",
        lines('<!DOCTYPE state SYSTEM "state[1].dtd">', "<state/>"),
        lines('<!DOCTYPE state SYSTEM "state[1].dtd">', "<state>saved</state>"),
      ),
    });

    expect(logged[0]?.suggested).not.toEqual([]);
    expect(
      noted[0]?.notes.some((note) => note.message.includes("internal subset")),
    ).toBe(false);
  });
});

describe("draftTaskFiles for a lock the export leaves out of a state directory", () => {
  it("drafts no check or guard on a lock directly in a state directory, which the export leaves out of the seed", () => {
    const [lock] = draftOf(
      {
        ".config/notes/sync.lock": statePath(
          "application_state",
          "text",
          textView("pid 1\n"),
          textView("pid 2\n"),
        ),
      },
      [],
      [".config/notes"],
    );

    expect(lock).toMatchObject({
      file: ".config/notes/sync.lock",
      suggested: [],
      guards: [],
    });
  });
});

describe("draftTaskFiles guards of a line-keyed catalogue, as Poedit saves one", () => {
  it("guards the other records' lines of the changed line's keyword, never its own record's source reference or msgid", () => {
    const entry = (line: number, msgid: string, msgstr: string) => [
      `#: argparse.py:${String(line)}`,
      `msgid "${msgid}"`,
      `msgstr "${msgstr}"`,
      "",
    ];
    const catalogue = (fixed: string) =>
      [
        ...entry(1811, "positional arguments", "arguments positionnels"),
        ...entry(1858, "cannot have multiple subparser arguments", ""),
        ...entry(2249, "expected one argument", fixed),
        ...entry(
          2250,
          "expected at most one argument",
          "au plus un argument attendu",
        ),
        ...entry(2312, "ambiguous option", ""),
      ].join("\n");
    const file = "Documents/fr.po";
    const [drafted] = draftOf({
      [file]: statePath(
        "document",
        "text",
        textView(catalogue("un argument inattendu")),
        textView(catalogue("un argument attendu")),
      ),
    });

    expect(drafted?.guards).toEqual([
      {
        kind: "lines_present",
        file,
        lines: [
          'msgstr "arguments positionnels"',
          'msgstr "au plus un argument attendu"',
        ],
      },
    ]);
  });
});
