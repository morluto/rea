import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import { desktopApplicationStateSchema } from "../../domain/desktop/desktopState.js";
import {
  odtArchive,
  zipArchive,
} from "../../domain/desktop/zipArchive.fixture.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import { inspectDesktopApplicationState } from "./DesktopApplicationState.js";
import { DESKTOP_OPERATION } from "./DesktopCaptureRefusals.js";
import { draftDesktopApplicationTask } from "./DesktopTaskDraft.js";
import {
  HOME,
  capture,
  change,
  readers,
  retained,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

const FREECAD = join(
  import.meta.dirname,
  "../../../tests/fixtures/freecad/1.0",
);
const PLATE = "Documents/plate.FCStd";
const LIST = "Documents/list.odt";
/** The list's paragraphs, by their prefixed element names. */
const LIST_TEXT =
  "/entries/[name=content.xml]/view/root/children/[name=office:body]/children/[name=office:text]/children";

/** FreeCAD's save of the plate, before and after the user cut the hole. */
const plate = async (end: "before" | "after") =>
  zipArchive([
    {
      name: "Document.xml",
      data: await readFile(join(FREECAD, end, "Document.xml")),
    },
    { name: "thumbnails/Thumbnail.png", data: Buffer.from([0x89, 0x50, 0]) },
  ]);

/** The notes capture with a FreeCAD document and an OpenDocument list the user also edited, both named in window titles. */
const archiveCapture = async (
  list: readonly [Buffer, Buffer] = [
    odtArchive("Buy bread"),
    odtArchive("Buy milk"),
  ],
) => {
  const base = capture();
  const [first, second] = base.state.checkpoints;
  if (first === undefined || second === undefined) throw new Error("fixture");
  const files = {
    [`${HOME}/${PLATE}`]: [await plate("before"), await plate("after")],
    [`${HOME}/${LIST}`]: list,
  } as const;
  const captured: DesktopApplicationCapture = {
    ...base,
    session: {
      ...base.session,
      windows: base.session.windows.map((window) => ({
        ...window,
        titles: [...window.titles, "plate.FCStd - Notes", "list.odt - Notes"],
      })),
    },
    state: {
      ...base.state,
      checkpoints: [
        {
          ...first,
          retained: [
            ...first.retained,
            ...Object.entries(files).map(([path, [before]]) =>
              retained(path, before),
            ),
          ],
        },
        {
          ...second,
          changes: [
            ...second.changes,
            ...Object.entries(files).map(([path, [before, after]]) =>
              change(path, { before, after }),
            ),
          ],
          retained: [
            ...second.retained,
            ...Object.entries(files).map(([path, [, after]]) =>
              retained(path, after),
            ),
          ],
        },
      ],
    },
  };
  return writeCaptureFolder(
    captured,
    DESKTOP_OPERATION,
    Object.values(files).flat(),
  );
};

const HOLE = {
  kind: "value_equals",
  file: PLATE,
  pointer:
    "/entries/[name=Document.xml]/view/root/children/[name=ObjectData]/children/[name=Object][@name=Hole]/children/[name=Properties]/children/[name=Property][@name=Radius]/children/[name=Float]/attributes/value",
  value: 5,
  tolerance: 0.01,
};

/** The entries of the list document's last version in the capture's state view. */
const endEntries = async (folder: string) => {
  const evidence = await inspectDesktopApplicationState(folder, readers);
  if (!("normalized_result" in evidence)) throw evidence;
  const state = desktopApplicationStateSchema.parse(evidence.normalized_result);
  const end = state.paths
    .find((entry) => entry.home_path === LIST)
    ?.versions.at(-1)?.view;
  return (
    (end as { entries: Record<string, unknown>[] } | undefined)?.entries ?? []
  );
};

const exportTask = async (folder: string, checks: unknown[]) => {
  const scratch = await createTestTempDirectory("desktop-archive-task-");
  const path = join(scratch, "task.json");
  await writeFile(
    path,
    JSON.stringify({
      name: "cut-hole",
      prompt: "Cut a 10 mm hole through the plate and save it.",
      checks,
    }),
  );
  const directory = join(scratch, "bundle");
  const result = await exportDesktopApplication(
    { capture: folder, directory, name: undefined, tasks: [path] },
    readers,
  );
  return { result, directory };
};

it.each([
  { seedTitle: "done", accepted: false },
  { seedTitle: "before", accepted: true },
])(
  "checks the recompressed gzip archive's real seed view (accepted: $accepted)",
  async ({ seedTitle, accepted }) => {
    const archive = (title: string) =>
      zipArchive([
        { name: "state.json", data: JSON.stringify({ title }), method: 0 },
        { name: "padding.txt", data: "x".repeat(60_000), method: 0 },
      ]);
    const seed = gzipSync(archive(seedTitle), { level: 9 });
    const end = gzipSync(archive("done"), { level: 0 });
    const folder = await archiveCapture([seed, end]);
    const state = await inspectDesktopApplicationState(folder, readers);
    if (!("normalized_result" in state)) throw state;
    const versions = desktopApplicationStateSchema
      .parse(state.normalized_result)
      .paths.find((entry) => entry.home_path === LIST)?.versions;
    expect(versions?.[0]).toMatchObject({
      format: null,
      compression: "gzip",
    });
    expect(versions?.at(-1)).toMatchObject({
      format: "zip",
      compression: "gzip",
    });
    const { result } = await exportTask(folder, [
      {
        kind: "value_equals",
        file: LIST,
        pointer: "/entries/[name=state.json]/view/title",
        value: "done",
      },
    ]);
    if (accepted) {
      if (result instanceof Error) throw result;
      expect(result.normalized_result).toMatchObject({
        task: { failing_on_seed: ["check-1"] },
      });
    } else {
      expect(result).toBeInstanceOf(Error);
      expect((result as Error & { userMessage: string }).userMessage).toContain(
        "already passes on the seed",
      );
    }
  },
);

describe("documents saved as zip archives", () => {
  it("reads each version into its entries and lists the change by entry and element name", async () => {
    const evidence = await inspectDesktopApplicationState(
      await archiveCapture(),
      readers,
    );
    if (!("normalized_result" in evidence)) throw evidence;
    const state = desktopApplicationStateSchema.parse(
      evidence.normalized_result,
    );
    const path = state.paths.find((entry) => entry.home_path === PLATE);

    expect(path).toMatchObject({
      role: "document",
      format: "zip",
      versions: [
        { format: "zip", view: { entry_count: 2, truncated: false } },
        { format: "zip", view_error: null },
      ],
      changes: [{ kind: "values", complete: true }],
    });
    expect(path?.changes[0]?.added).toContain(
      "/entries/[name=Document.xml]/view/root/children/[name=Objects]/children/[name=Object][@name=Hole]",
    );
  });

  it("exports a task that checks the hole and the list's namespaced XML by name", async () => {
    const folder = await archiveCapture();
    const milk = {
      kind: "value_equals",
      file: LIST,
      pointer: `${LIST_TEXT}/[name=text:p]/children/0`,
      value: "Buy milk",
    };

    const { result, directory } = await exportTask(folder, [HOLE, milk]);
    if (result instanceof Error) throw result;
    const verifier = await readFile(
      join(directory, "artifacts/cut-hole-check/verify.py"),
      "utf8",
    );
    expect(verifier).toContain(`"tolerance": 0.01`);
    expect(verifier).toContain(JSON.stringify(milk.pointer));
  });

  it("accepts a check on the whole listing, whose value holds namespaced XML", async () => {
    const folder = await archiveCapture();
    const entries = await endEntries(folder);
    expect(entries).toHaveLength(3);

    const { result } = await exportTask(folder, [
      { kind: "value_equals", file: LIST, pointer: "/entries", value: entries },
    ]);

    if (result instanceof Error) throw result;
  });

  it("exports checks of a namespaced entry's metadata, its absence, and the entry compared whole", async () => {
    const comments = {
      name: "comments.xml",
      data: '<office:annotations xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>',
    };
    const folder = await archiveCapture([
      odtArchive("Buy bread", [comments]),
      odtArchive("Buy milk"),
    ]);
    const content = (await endEntries(folder)).find(
      (entry) => entry.name === "content.xml",
    );

    const { result } = await exportTask(folder, [
      {
        kind: "value_equals",
        file: LIST,
        pointer: "/entries/[name=content.xml]/size",
        value: content?.size,
      },
      {
        kind: "value_absent",
        file: LIST,
        pointer: "/entries/[name=comments.xml]",
      },
    ]);
    expect(
      result instanceof Error
        ? (result as Error & { userMessage: string }).userMessage
        : undefined,
    ).toBeUndefined();

    const whole = await exportTask(folder, [
      {
        kind: "value_equals",
        file: LIST,
        pointer: "/entries/[name=content.xml]",
        value: content,
      },
    ]);
    if (whole.result instanceof Error) throw whole.result;
  });

  it("drafts name-addressed checks of the archive that the export then accepts", async () => {
    const folder = await archiveCapture();

    const drafted = await draftDesktopApplicationTask(folder, readers);
    if (drafted instanceof Error) throw drafted;
    const task = (
      drafted.normalized_result as {
        task: { checks: { file: string; pointer?: string }[] };
      }
    ).task;

    const archived = task.checks.filter(({ file }) => file === PLATE);
    expect(archived.length).toBeGreaterThan(0);
    expect(
      archived.every(({ pointer }) => pointer?.includes("[name=") === true),
    ).toBe(true);
    expect(task.checks.filter(({ file }) => file === LIST)).toEqual([
      expect.objectContaining({
        kind: "text_equals",
        pointer: `${LIST_TEXT}/[name=text:p]`,
        value: "Buy milk",
      }),
    ]);
    const { result } = await exportTask(folder, task.checks);
    expect(result).not.toBeInstanceOf(Error);
  });
});

describe("task draft values and guards", () => {
  /** The draft's files, checks and guards, as describe-desktop-application-task returns them. */
  const draftOf = async (folder: string) => {
    const drafted = await draftDesktopApplicationTask(folder, readers);
    if (drafted instanceof Error) throw drafted;
    return drafted.normalized_result as {
      files: {
        file: string;
        values: { pointer: string; kind: string }[];
        values_cut: boolean;
      }[];
      task: { checks: { id: string }[] };
      guards: { id: string }[];
    };
  };

  it("lists each archive's values by the pointers checks use, and guards the export accepts beside the checks", async () => {
    const folder = await archiveCapture();

    const { files, task, guards } = await draftOf(folder);

    const plate = files.find(({ file }) => file === PLATE);
    expect(plate?.values_cut).toBe(false);
    expect(
      plate?.values.map(({ kind, pointer }) => [kind, pointer]),
    ).toContainEqual([
      "added",
      "/entries/[name=Document.xml]/view/root/children/[name=Objects]/children/[name=Object][@name=Hole]",
    ]);
    expect(guards.map(({ id }) => id)).toEqual(
      guards.map((_, index) => `guard-${String(index + 1)}`),
    );
    expect(guards.length).toBeGreaterThan(0);
    // Guards hold at the seed and the end, so the task still fails on the seed only through its checks.
    const { result } = await exportTask(folder, [...task.checks, ...guards]);
    if (result instanceof Error) throw result;
  });

  it("points a refused check at the draft's values", async () => {
    const folder = await archiveCapture();

    const { result } = await exportTask(folder, [{ ...HOLE, value: 7 }]);

    expect(result).toBeInstanceOf(Error);
    const remediation = (result as Error & { remediationAction?: string })
      .remediationAction;
    for (const name of ["values", "stop_build_capture"])
      expect(remediation).toContain(name);
  });
});

describe("paragraphs split into runs", () => {
  it("drafts and exports a paragraph's whole text once an edit split it into runs, which its first run does not hold", async () => {
    const run = (text: string) =>
      `<text:span text:style-name="T1">${text}</text:span>`;
    const folder = await archiveCapture([
      odtArchive("Buy bread"),
      odtArchive(`Buy ${run("oat")} ${run("milk")}`),
    ]);
    const paragraph = `${LIST_TEXT}/[name=text:p]`;

    const drafted = await draftDesktopApplicationTask(folder, readers);
    if (drafted instanceof Error) throw drafted;
    const { checks } = (
      drafted.normalized_result as { task: { checks: { file: string }[] } }
    ).task;
    expect(checks.filter(({ file }) => file === LIST)).toEqual([
      expect.objectContaining({
        kind: "text_equals",
        pointer: paragraph,
        value: "Buy oat milk",
      }),
    ]);

    const whole = await exportTask(folder, [
      HOLE,
      {
        kind: "text_equals",
        file: LIST,
        pointer: paragraph,
        value: "Buy oat milk",
      },
    ]);
    if (whole.result instanceof Error) throw whole.result;
    expect(whole.result.normalized_result).toMatchObject({
      tasks: [{ failing_on_seed: ["check-1", "check-2"] }],
    });

    const first = await exportTask(folder, [
      HOLE,
      {
        kind: "value_equals",
        file: LIST,
        pointer: `${paragraph}/children/0`,
        value: "Buy oat milk",
      },
    ]);
    expect(first.result).toBeInstanceOf(Error);
    // The first run holds only the text before the first span.
    for (const fact of ['"check-2"', JSON.stringify("Buy ")])
      expect(
        (first.result as Error & { userMessage: string }).userMessage,
      ).toContain(fact);
  });
});
