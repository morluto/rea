import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import { desktopApplicationStateSchema } from "../../domain/desktop/desktopState.js";
import { openStateDocument } from "../../domain/desktop/gzipDocument.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import { inspectDesktopApplicationState } from "./DesktopApplicationState.js";
import { draftDesktopApplicationTask } from "./DesktopTaskDraft.js";
import {
  HOME,
  capture,
  change,
  readers,
  retained,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

const BUDGET = "Documents/Budget.gnumeric";
const HOSTNAME = "e81232be457d";
const SEED = "envs/notes/seed/Documents/Budget.gnumeric";
const CELLS =
  "/root/children/[name=gnm:Sheets]/children/[name=gnm:Sheet][>gnm:Name=Budget]/children/[name=gnm:Cells]/children";

/** A Gnumeric workbook's XML with its rent, author and any comment as given. */
const workbook = (
  rent: string,
  author: string,
  comment = "",
) => `<?xml version="1.0" encoding="UTF-8"?>
<gnm:Workbook xmlns:gnm="http://www.gnumeric.org/v10.dtd">
  <gnm:Summary><gnm:Item><gnm:name>author</gnm:name><gnm:val-string>${author}</gnm:val-string></gnm:Item></gnm:Summary>
  <gnm:Comment>${comment}</gnm:Comment>
  <gnm:Sheets><gnm:Sheet><gnm:Name>Budget</gnm:Name><gnm:Cells>
    <gnm:Cell Row="0" Col="0" ValueType="60">Rent</gnm:Cell>
    <gnm:Cell Row="0" Col="1" ValueType="40">${rent}</gnm:Cell>
  </gnm:Cells></gnm:Sheet></gnm:Sheets>
</gnm:Workbook>
`;

/**
 * The notes capture of a host with the workbook, named in a window title,
 * saved before and after the user changed the rent and set the author to the
 * value the scrub writes, each save made by `save`, with any other files the
 * app kept unchanged by their home path.
 */
const budgetCapture = (
  save: (text: string) => Buffer,
  comment = "",
  kept: Readonly<Record<string, Buffer>> = {},
) => {
  const before = save(workbook("1200", `ada@${HOSTNAME}`, comment));
  const after = save(workbook("1350", "user@localhost", comment));
  const base = capture();
  const [first, second] = base.state.checkpoints;
  if (first === undefined || second === undefined) throw new Error("fixture");
  const path = `${HOME}/${BUDGET}`;
  const captured: DesktopApplicationCapture = {
    ...base,
    host: { ...base.host, hostname: HOSTNAME, user: "ada" },
    session: {
      ...base.session,
      windows: base.session.windows.map((window) => ({
        ...window,
        titles: [...window.titles, "Budget.gnumeric - Notes"],
      })),
    },
    state: {
      ...base.state,
      checkpoints: [
        {
          ...first,
          retained: [
            ...first.retained,
            retained(path, before),
            ...Object.entries(kept).map(([home, bytes]) =>
              retained(`${HOME}/${home}`, bytes),
            ),
          ],
        },
        {
          ...second,
          changes: [...second.changes, change(path, { before, after })],
          retained: [...second.retained, retained(path, after)],
        },
      ],
    },
  };
  return writeCaptureFolder(captured, undefined, [
    before,
    after,
    ...Object.values(kept),
  ]);
};

const gzipped = (text: string) => gzipSync(text);
const plain = (text: string) => Buffer.from(text);

/** The workbook's path in the capture's state view. */
const budgetState = async (folder: string) => {
  const evidence = await inspectDesktopApplicationState(folder, readers);
  if (!("normalized_result" in evidence)) throw evidence;
  return desktopApplicationStateSchema
    .parse(evidence.normalized_result)
    .paths.find((path) => path.home_path === BUDGET);
};

const draftOf = async (folder: string) => {
  const drafted = await draftDesktopApplicationTask(folder, readers);
  if (drafted instanceof Error) throw drafted;
  return drafted.normalized_result;
};

/** Export the capture with a task that checks the rent and the author the scrub writes. */
const exportBudget = async (folder: string) => {
  const scratch = await createTestTempDirectory("desktop-gzip-task-");
  const task = join(scratch, "task.json");
  const directory = join(scratch, "bundle");
  await writeFile(
    task,
    JSON.stringify({
      name: "rent",
      prompt: "Set the rent to 1350 in my budget and save it.",
      checks: [
        {
          id: "rent",
          kind: "value_equals",
          file: BUDGET,
          pointer: `${CELLS}/[name=gnm:Cell][@Row=0][@Col=1]/children/0`,
          value: "1350",
        },
        {
          id: "author",
          kind: "text_equals",
          file: BUDGET,
          pointer:
            "/root/children/[name=gnm:Summary]/children/[name=gnm:Item]/children/[name=gnm:val-string]",
          value: "user@localhost",
        },
      ],
    }),
  );

  const result = await exportDesktopApplication(
    { capture: folder, directory, name: undefined, tasks: [task] },
    readers,
  );
  return { result, directory };
};

describe("documents saved gzip-compressed", () => {
  it("reads each version as the XML inside, the view the same workbook has uncompressed, and records the compression", async () => {
    const compressed = await budgetState(await budgetCapture(gzipped));
    const uncompressed = await budgetState(await budgetCapture(plain));

    expect(compressed).toMatchObject({
      role: "document",
      format: "xml",
      versions: [
        { format: "xml", compression: "gzip", view_error: null },
        { format: "xml", compression: "gzip", view_error: null },
      ],
      changes: [{ kind: "values", changed_count: 2 }],
    });
    expect(uncompressed?.versions[0]?.compression).toBeUndefined();
    expect(compressed?.versions.map(({ view }) => view)).toEqual(
      uncompressed?.versions.map(({ view }) => view),
    );
    expect(compressed?.changes).toEqual(uncompressed?.changes);
  });

  it("drafts the same files, values, checks, guards and notes as the same workbook uncompressed", async () => {
    const compressed = await draftOf(await budgetCapture(gzipped));

    expect(compressed).toEqual(await draftOf(await budgetCapture(plain)));
    expect(
      (compressed as { task: { checks: unknown[] } }).task.checks,
    ).toContainEqual(
      expect.objectContaining({
        file: BUDGET,
        pointer: `${CELLS}/[name=gnm:Cell][@Col=1]`,
        value: "1350",
      }),
    );
  });

  it("ships the seed scrubbed inside and still gzip, copied as it is at boot, and checks the seed as shipped", async () => {
    const { result, directory } = await exportBudget(
      await budgetCapture(gzipped),
    );

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      scrubbed_files: [SEED],
      unscrubbed_files: [],
      task: { failing_on_seed: ["rent"] },
    });
    const shipped = await readFile(join(directory, SEED));
    expect([...shipped.subarray(0, 4)]).toEqual([0x1f, 0x8b, 8, 0]);
    expect(gunzipSync(shipped).toString("utf8")).toBe(
      workbook("1200", "user@localhost"),
    );
    const module = await readFile(
      join(directory, "envs/notes/notes_app.py"),
      "utf8",
    );
    // Boot respells text seeds as UTF-8, so the gzip workbook is not one of them.
    expect(module).toContain(
      'TEXT_SEEDS = frozenset([".config/notes/settings.ini"])',
    );
  });

  it("lists gzip seeds recompressed only to clear their headers apart from the document whose content was scrubbed", async () => {
    const templates = ["blank", "invoice", "loan"].map(
      (name) => `.local/share/notes/templates/${name}.xml.gz`,
    );
    const kept = Object.fromEntries(
      templates.map((home) => [home, gzipSync(`<template name="${home}"/>`)]),
    );

    const { result, directory } = await exportBudget(
      await budgetCapture(gzipped, "", kept),
    );

    if (result instanceof Error) throw result;
    const recompressed = templates.map((home) => `envs/notes/seed/${home}`);
    expect(result.normalized_result).toMatchObject({
      scrubbed_files: [SEED],
      recompressed_files: recompressed,
      unscrubbed_files: [],
    });
    const readme = await readFile(join(directory, "README.md"), "utf8");
    expect(readme).toContain(`\`${SEED}\``);
    expect(recompressed.filter((path) => readme.includes(path))).toEqual([]);
    expect(readme).toMatch(/\b3 gzip file\(s\)/u);
    for (const path of recompressed)
      expect(
        gunzipSync(await readFile(join(directory, path))).toString("utf8"),
      ).toBe(`<template name="${path.slice("envs/notes/seed/".length)}"/>`);
  });

  it("lists a gzip seed recompressed, and a LibreOffice registry both scrubbed and left without its recovery list, each in its own list", async () => {
    const template = ".local/share/notes/templates/blank.xml.gz";
    const registry = ".config/notes/registrymodifications.xcu";
    const kept = {
      [template]: gzipSync('<template name="blank"/>'),
      [registry]: Buffer.from(
        [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<oor:items xmlns:oor="http://openoffice.org/2001/registry">',
          `<item oor:path="/org.openoffice.UserProfile/Data"><prop oor:name="o" oor:op="fuse"><value>ada@${HOSTNAME}</value></prop></item>`,
          `<item oor:path="/org.openoffice.Office.Recovery/RecoveryList"><node oor:name="recovery_item_1" oor:op="replace"><prop oor:name="OriginalURL" oor:op="fuse"><value>file://${HOME}/${BUDGET}</value></prop></node></item>`,
          "</oor:items>",
          "",
        ].join("\n"),
      ),
    };

    const { result, directory } = await exportBudget(
      await budgetCapture(gzipped, "", kept),
    );

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      scrubbed_files: [`envs/notes/seed/${registry}`, SEED],
      recompressed_files: [`envs/notes/seed/${template}`],
      unscrubbed_files: [],
    });
    const shipped = await readFile(
      join(directory, "envs/notes/seed", registry),
      "utf8",
    );
    expect(shipped).not.toContain("RecoveryList");
    expect(shipped).toContain("<value>user@localhost</value>");
    expect(
      result.limitations.filter((line) => line.includes(`~/${registry}`)),
    ).toHaveLength(1);
    const readme = await readFile(join(directory, "README.md"), "utf8");
    expect(readme).toMatch(/\b1 gzip file\(s\)/u);
    expect(readme).toContain(`\`~/${registry}\``);
  });

  it("keeps a seed the app stored uncompressed readable once scrubbed, where deflating it would pass the 100 times a view reads", async () => {
    const stored = (text: string) => gzipSync(text, { level: 0 });
    const comment = "x".repeat(60_000);

    const { result, directory } = await exportBudget(
      await budgetCapture(stored, comment),
    );

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      task: { failing_on_seed: ["rent"] },
    });
    const shipped = await readFile(join(directory, SEED));
    expect(openStateDocument(BUDGET, shipped)).toMatchObject({
      format: "xml",
      compression: "gzip",
    });
    expect(openStateDocument(BUDGET, shipped)).not.toHaveProperty("error");
  });
});
