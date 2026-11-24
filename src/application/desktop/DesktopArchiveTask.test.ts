import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import { desktopApplicationStateSchema } from "../../domain/desktop/desktopState.js";
import {
  odtArchive,
  zipArchive,
} from "../../domain/desktop/zipArchive.fixture.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import { inspectDesktopApplicationState } from "./DesktopApplicationState.js";
import { ArtifactReaderFailure } from "../../resources/ArtifactReader.js";
import { readZipView } from "./DesktopZipView.js";
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

const inspectArchives = async (folder: string) => {
  const evidence = await inspectDesktopApplicationState(folder, readers);
  if (evidence instanceof Error) throw evidence;
  return desktopApplicationStateSchema.parse(evidence.normalized_result);
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
    const state = await inspectArchives(folder);
    const versions = state.paths.find(
      (entry) => entry.home_path === LIST,
    )?.versions;
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
        tasks: [{ failing_on_seed: ["check-1"] }],
      });
    } else {
      expect(result).toBeInstanceOf(Error);
      expect((result as Error & { userMessage: string }).userMessage).toContain(
        "already passes on the seed",
      );
    }
  },
);

it("retains typed cancellation at the retained ZIP reader boundary", async () => {
  const bytes = zipArchive([{ name: "state.json", data: '{"value":"kept"}' }]);
  expect(await readZipView(bytes)).toMatchObject({
    ok: true,
    value: { entry_count: 1, truncated: false },
  });
  const controller = new AbortController();
  const reason = { code: "EACCES", source: "caller" };
  controller.abort(reason);
  const failure: unknown = await readZipView(bytes, controller.signal).catch(
    (cause: unknown) => cause,
  );
  expect(failure).toBeInstanceOf(ArtifactReaderFailure);
  if (!(failure instanceof ArtifactReaderFailure)) throw failure;
  expect(failure.reason).toBe("cancelled");
  expect(failure.cause).toBe(reason);
  expect(failure.cancellation?.reason).toBe(reason);
});

const HOLE_ADDED =
  "/entries/[name=Document.xml]/view/root/children/[name=Objects]/children/[name=Object][@name=Hole]";

describe("documents saved as zip archives", () => {
  it("drafts archive changes by name and exports them with guards that hold at both ends", async () => {
    const folder = await archiveCapture();
    const state = await inspectArchives(folder);
    const plate = state.paths.find((entry) => entry.home_path === PLATE);
    expect(plate).toMatchObject({
      role: "document",
      format: "zip",
      versions: [
        { format: "zip", view: { entry_count: 2, truncated: false } },
        { format: "zip", view_error: null },
      ],
      changes: [
        {
          kind: "values",
          complete: true,
          added: expect.arrayContaining([HOLE_ADDED]),
        },
      ],
    });

    const draft = await draftDesktopApplicationTask(folder, readers);
    if (draft instanceof Error) throw draft;
    const { files, task, guards } = draft.normalized_result as {
      files: { file: string }[];
      task: { checks: { id: string; file: string; pointer?: string }[] };
      guards: { id: string }[];
    };
    expect(files.find(({ file }) => file === PLATE)).toMatchObject({
      values_cut: false,
      values: expect.arrayContaining([
        expect.objectContaining({ kind: "added", pointer: HOLE_ADDED }),
      ]),
    });
    const archived = task.checks.filter(({ file }) => file === PLATE);
    expect(archived.length).toBeGreaterThan(0);
    for (const { pointer } of archived) expect(pointer).toContain("[name=");
    expect(task.checks.filter(({ file }) => file === LIST)).toEqual([
      expect.objectContaining({
        kind: "text_equals",
        pointer: `${LIST_TEXT}/[name=text:p]`,
        value: "Buy milk",
      }),
    ]);
    expect(guards.length).toBeGreaterThan(0);

    const { result } = await exportTask(folder, [...task.checks, ...guards]);
    if (result instanceof Error) throw result;
    const report = result.normalized_result as {
      tasks: { checks: number; failing_on_seed: string[] }[];
    };
    expect(report.tasks[0]?.checks).toBe(task.checks.length + guards.length);
    const failures = report.tasks[0]?.failing_on_seed;
    expect(failures).toContain(archived[0]?.id);
    for (const { id } of guards) expect(failures).not.toContain(id);
  });

  it("exports archive member checks by name, including absence and whole-entry values", async () => {
    const folder = await archiveCapture([
      odtArchive("Buy bread", [
        {
          name: "comments.xml",
          data: '<office:annotations xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>',
        },
      ]),
      odtArchive("Buy milk"),
    ]);
    const state = await inspectArchives(folder);
    const end = state.paths
      .find(({ home_path }) => home_path === LIST)
      ?.versions.at(-1);
    const entries = (
      end?.view as { entries: { name: string; size: number }[] } | undefined
    )?.entries;
    const content = entries?.find(({ name }) => name === "content.xml");
    expect(entries).toHaveLength(3);
    if (content === undefined) throw new Error("Missing archived content.xml");
    const milk = {
      kind: "value_equals",
      file: LIST,
      pointer: `${LIST_TEXT}/[name=text:p]/children/0`,
      value: "Buy milk",
    };
    const { result, directory } = await exportTask(folder, [
      { ...HOLE, value: 5.005 },
      milk,
      { kind: "value_equals", file: LIST, pointer: "/entries", value: entries },
      {
        kind: "value_equals",
        file: LIST,
        pointer: "/entries/[name=content.xml]/size",
        value: content.size,
      },
      {
        kind: "value_absent",
        file: LIST,
        pointer: "/entries/[name=comments.xml]",
      },
      {
        kind: "value_equals",
        file: LIST,
        pointer: "/entries/[name=content.xml]",
        value: content,
      },
    ]);
    expect(
      result,
      result instanceof AnalysisError ? result.userMessage : undefined,
    ).toMatchObject({
      normalized_result: {
        tasks: [
          {
            failing_on_seed: [
              "check-1",
              "check-2",
              "check-3",
              "check-4",
              "check-5",
              "check-6",
            ],
          },
        ],
      },
    });
    const verifier = await readFile(
      join(directory, "artifacts/cut-hole-check/verify.py"),
      "utf8",
    );
    expect(verifier).toContain(`"tolerance": 0.01`);
    expect(verifier).toContain(JSON.stringify(milk.pointer));
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
