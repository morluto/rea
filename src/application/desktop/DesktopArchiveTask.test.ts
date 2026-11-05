import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
const archiveCapture = async () => {
  const base = capture();
  const [first, second] = base.state.checkpoints;
  if (first === undefined || second === undefined) throw new Error("fixture");
  const files = {
    [`${HOME}/${PLATE}`]: [await plate("before"), await plate("after")],
    [`${HOME}/${LIST}`]: [odtArchive("Buy bread"), odtArchive("Buy milk")],
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

  it("exports a task that checks the hole by name, and refuses a check into namespaced XML", async () => {
    const folder = await archiveCapture();

    const { result, directory } = await exportTask(folder, [HOLE]);
    if (result instanceof Error) throw result;
    expect(
      await readFile(
        join(directory, "artifacts/cut-hole-check/verify.py"),
        "utf8",
      ),
    ).toContain(`"tolerance": 0.01`);

    const refused = await exportTask(folder, [
      HOLE,
      {
        kind: "value_equals",
        file: LIST,
        pointer:
          "/entries/[name=content.xml]/view/root/children/0/children/0/children/0/children/0",
        value: "Buy milk",
      },
    ]);
    expect(
      (refused.result as Error & { userMessage: string }).userMessage,
    ).toContain(
      "points into content.xml in Documents/list.odt, whose XML uses namespaces the verifier names differently",
    );
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
    expect(task.checks.some(({ file }) => file === LIST)).toBe(false);
    const { result } = await exportTask(folder, task.checks);
    expect(result).not.toBeInstanceOf(Error);
  });
});
