import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { WORK } from "../../../src/application/desktop/DesktopBuildCommands.js";
import {
  NOTE,
  seedEndCapture,
} from "../../../src/application/desktop/desktopCapture.fixture.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import type { DesktopApplicationCapture } from "../../../src/domain/desktop/desktopCapture.js";
import {
  BUILD_REQUEST as REQUEST,
  BUILD_TASK as TASK,
  buildCaptureFakes,
} from "../../fixtures/buildCaptureFakes.js";
import { callOk, startBuildComputer } from "../../fixtures/buildComputerMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const DOCUMENT = "Documents/today.txt";

/** The seed-and-end capture of an app whose window titles never show the note's file name. */
const untitled = (): DesktopApplicationCapture => {
  const base = seedEndCapture();
  return {
    ...base,
    session: {
      ...base.session,
      windows: base.session.windows.map((window) => ({
        ...window,
        titles: ["Shopping - Notes"],
      })),
    },
  };
};

/** The same capture given `--state-path` for the note: it retained the note's path from the start, with its logs. */
const selectingNote = (): DesktopApplicationCapture => {
  const base = untitled();
  return {
    ...base,
    state: {
      ...base.state,
      content_roots: [
        ...base.state.content_roots,
        NOTE,
        `${NOTE}-wal`,
        `${NOTE}-journal`,
      ],
    },
  };
};

const fakes = () =>
  buildCaptureFakes({
    recorded: untitled(),
    exportRefused: true,
    selected: { path: DOCUMENT, recorded: selectingNote() },
  });

/** Capture the note from seed to end on a new build computer, starting with `input`, and stop. */
const capture = async (
  client: Awaited<ReturnType<typeof fakes>>["client"],
  input: Record<string, unknown>,
) => {
  const id = await startBuildComputer(client, REQUEST);
  await callOk(client, "start_build_capture", { computer_id: id, ...input });
  for (const name of ["seed", "end"])
    await callOk(client, "mark_build_checkpoint", { computer_id: id, name });
  const stopped = toolContract("stop_build_capture").outputSchema.parse(
    (await callOk(client, "stop_build_capture", { computer_id: id }))
      .structuredContent,
  );
  return { id, stopped };
};

const exportTo = async (
  client: Awaited<ReturnType<typeof fakes>>["client"],
  id: string,
) =>
  client.callTool({
    name: "export_build_environment",
    arguments: {
      computer_id: id,
      task: TASK,
      directory: join(await createTestTempDirectory("build-out-"), "notes"),
    },
  });

it("makes a file named in state_paths the app's document, which the draft covers and an export's check reads", async () => {
  const { rea, client } = await fakes();

  const { id, stopped } = await capture(client, { state_paths: [DOCUMENT] });

  const calls = (await rea.notes("calls.jsonl")) as { argv: string[] }[];
  expect(
    calls.find(({ argv }) => argv[0] === "capture-desktop-application")?.argv,
  ).toEqual(expect.arrayContaining(["--state-path", join(rea.home, DOCUMENT)]));
  expect(stopped.draft).toMatchObject({
    files: [{ file: DOCUMENT, role: "document" }],
    task: { checks: [{ kind: "lines_present", file: DOCUMENT }] },
    notes: [],
  });
  const exported = toolContract("export_build_environment").outputSchema.parse(
    (await exportTo(client, id)).structuredContent,
  );
  expect(exported.seed_files).toContain(DOCUMENT);
  expect(exported.task).toMatchObject({ name: TASK.name });
});

it("says why a draft has no files when the app's document is not recognized, and the export names state_paths", async () => {
  const { rea, client } = await fakes();

  const { id, stopped } = await capture(client, {});

  const calls = (await rea.notes("calls.jsonl")) as { argv: string[] }[];
  const captureArgs = calls.find(
    ({ argv }) => argv[0] === "capture-desktop-application",
  )?.argv;
  expect(captureArgs).toBeDefined();
  expect(captureArgs).not.toContain("--state-path");
  expect(stopped.draft?.files).toEqual([]);
  expect(stopped.draft?.notes).toMatchObject([
    {
      code: "unowned_changes",
      files: [{ file: DOCUMENT, role: "unrelated" }],
      more: 0,
    },
    { code: "no_document" },
  ]);
  const { error } = parseMcpToolError(await exportTo(client, id));
  expect(error.code).toBe("invalid_request");
  expect(error.message).toContain(DOCUMENT);
  expect(error.message).toContain("state_paths");
});

it("refuses state_paths outside the home, through '..' or past the limit, and starts nothing for them", async () => {
  const { rea, client } = await fakes();
  const id = await startBuildComputer(client, REQUEST);
  const start = (statePaths: readonly string[]) =>
    client
      .callTool({
        name: "start_build_capture",
        arguments: { computer_id: id, state_paths: statePaths },
      })
      .then(parseMcpToolError);

  for (const [statePaths, index] of [
    [["Documents/../../outside.txt"], 0],
    [[DOCUMENT, "~"], 1],
  ] as const)
    expect((await start(statePaths)).error).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["state_paths", index] }] },
    });
  expect(
    (await start(Array.from({ length: 17 }, (_, n) => `Documents/${n}.txt`)))
      .error,
  ).toMatchObject({
    code: "invalid_request",
    details: { issues: [{ path: ["state_paths"] }] },
  });
  // Only the computer knows its home, so it refuses an absolute path outside it.
  const outside = await start(["/etc/hosts"]);
  expect(outside.error.code).toBe("invalid_request");
  expect(outside.error.message).toContain("/etc/hosts");
  expect(
    ((await rea.notes("calls.jsonl")) as { argv: string[] }[]).filter(
      ({ argv }) => argv[0] === "capture-desktop-application",
    ),
  ).toEqual([]);

  // A refused start leaves no capture behind, so the next one starts.
  await callOk(client, "start_build_capture", {
    computer_id: id,
    state_paths: [join(rea.home, DOCUMENT)],
  });
  const calls = (await rea.notes("calls.jsonl")) as { argv: string[] }[];
  expect(
    calls.filter(({ argv }) => argv[0] === "capture-desktop-application"),
  ).toHaveLength(1);
  expect(
    calls.find(({ argv }) => argv[0] === "capture-desktop-application")?.argv,
  ).toEqual(expect.arrayContaining(["--state-path", join(rea.home, DOCUMENT)]));
});

it("refuses a state path a link leads outside the home or into REA's work folder, existing yet or not, and starts nothing for it", async () => {
  const { rea, client } = await fakes();
  const id = await startBuildComputer(client, REQUEST);
  const outside = await createTestTempDirectory("outside-home-");
  await writeFile(join(outside, "state.json"), "{}\n");
  await symlink(outside, join(rea.home, "linked"));
  await symlink(join(outside, "gone.json"), join(rea.home, "dangling.json"));
  await symlink(join(rea.home, WORK, "x"), join(rea.home, "into-work"));
  const start = (statePath: string) =>
    client
      .callTool({
        name: "start_build_capture",
        arguments: { computer_id: id, state_paths: [DOCUMENT, statePath] },
      })
      .then(parseMcpToolError);

  for (const statePath of [
    "linked/state.json",
    "linked/not-yet.json",
    "linked/not/yet/deeper.json",
    "~/dangling.json",
    join(rea.home, "linked"),
    "into-work",
  ]) {
    const { error } = await start(statePath);
    expect(error.code, statePath).toBe("invalid_request");
    expect(error.message, statePath).toContain(statePath);
  }
  expect(
    ((await rea.notes("calls.jsonl")) as { argv: string[] }[]).filter(
      ({ argv }) => argv[0] === "capture-desktop-application",
    ),
  ).toEqual([]);

  // A link that stays in the home is followed, and the path passed as named.
  await mkdir(join(rea.home, "settings/MuseScore"), { recursive: true });
  await mkdir(join(rea.home, ".config"));
  await symlink(
    join(rea.home, "settings/MuseScore"),
    join(rea.home, ".config/MuseScore"),
  );
  await callOk(client, "start_build_capture", {
    computer_id: id,
    state_paths: [".config/MuseScore", ".config/MuseScore/not-yet.ini"],
  });
  const calls = (await rea.notes("calls.jsonl")) as { argv: string[] }[];
  expect(
    calls.find(({ argv }) => argv[0] === "capture-desktop-application")?.argv,
  ).toEqual(
    expect.arrayContaining([
      "--state-path",
      join(rea.home, ".config/MuseScore"),
      "--state-path",
      join(rea.home, ".config/MuseScore/not-yet.ini"),
    ]),
  );
});
