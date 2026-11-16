import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import {
  EDITED_NOTE,
  seedEndCapture,
  writeCaptureFolder,
} from "../../src/application/desktop/desktopCapture.fixture.js";
import type {
  DesktopApplicationCapture,
  DesktopPackage,
} from "../../src/domain/desktop/desktopCapture.js";
import { serveCli } from "../boundary/cli/cliServeHarness.js";
import { buildComputerFakes, connectBuildServer } from "./buildComputerMcp.js";
import { fakeBuildComputerRea } from "./fakeBuildComputerRea.js";
import { createTestTempDirectory } from "./temporaryDirectory.js";

/** The task the agent writes for the seed-and-end capture. */
export const BUILD_TASK = {
  name: "add-eggs",
  prompt: "Add eggs to today's list and save it.",
  checks: [
    { kind: "lines_present", file: "Documents/today.txt", lines: ["eggs"] },
  ],
};
/** A request for an app from the Ubuntu archive. */
export const BUILD_REQUEST = {
  kind: "request",
  desktop_entry: "org.example.notes",
  install: { kind: "archive", package: "notes" },
};
const ENDS = ["--seed-checkpoint", "seed", "--end-checkpoint", "end"];

/** The app's package as the capture records it, the URL the export downloads its file from, if it needs one, the download it was installed from, if any, and the packages it installs beside the app. */
interface CapturedInstall {
  readonly package?: DesktopPackage;
  readonly packageUrl?: string;
  readonly downloadInstall?: Readonly<Record<string, string>>;
  readonly extraPackages?: readonly string[];
}

/** A task the export takes with the checkpoint it is checked at. */
interface BuildTaskAtEnd {
  readonly task: unknown;
  readonly end_checkpoint: string;
}

/**
 * What the real CLI writes for a capture made between seed and end, by
 * default `seedEndCapture`: the draft, and the export with BUILD_TASK, or
 * `tasks` each at its end checkpoint, which must succeed unless `exportRefused`.
 */
const realCliOutputs = async (
  install: CapturedInstall | undefined,
  recorded: DesktopApplicationCapture = seedEndCapture(),
  {
    exportRefused = false,
    extraContent = [],
    tasks = [{ task: BUILD_TASK, end_checkpoint: "end" }],
    exportArgs = [],
  }: {
    exportRefused?: boolean;
    extraContent?: readonly string[];
    tasks?: readonly BuildTaskAtEnd[];
    exportArgs?: readonly string[];
  } = {},
) => {
  const capture = await writeCaptureFolder(
    install?.package === undefined
      ? recorded
      : {
          ...recorded,
          application: { ...recorded.application, package: install.package },
        },
    undefined,
    [EDITED_NOTE, ...extraContent],
  );
  const work = await createTestTempDirectory("build-cli-");
  const taskFiles = await Promise.all(
    tasks.map(async ({ task }, index) => {
      const path = join(work, `task-${String(index)}.json`);
      await writeFile(path, JSON.stringify(task));
      return path;
    }),
  );
  const bundle = join(work, "bundle");
  const download = join(work, "download-install.json");
  if (install?.downloadInstall !== undefined)
    await writeFile(download, JSON.stringify(install.downloadInstall));
  const withheld = join(work, "withheld");
  const schema = await serveCli([
    "export-desktop-application",
    "--schema",
    "--json",
  ]);
  expect(schema.exitCode, schema.stdout).toBe(0);
  await writeFile(join(work, "schema.json"), schema.stdout);
  const draft = await serveCli([
    "describe-desktop-application-task",
    capture,
    ...ENDS,
    "--json",
  ]);
  const exported = await serveCli([
    "export-desktop-application",
    capture,
    bundle,
    ...taskFiles.flatMap((path) => ["--task", path]),
    ...(tasks.length === 1
      ? []
      : tasks.flatMap(({ task, end_checkpoint }) => [
          "--task-end",
          `${(task as { name: string }).name}=${end_checkpoint}`,
        ])),
    ...ENDS,
    "--synthetic-seed",
    ...(install?.packageUrl === undefined
      ? []
      : ["--package-url", install.packageUrl]),
    ...(install?.downloadInstall === undefined
      ? []
      : ["--download-install", download]),
    ...(install?.extraPackages ?? []).flatMap((name) => [
      "--extra-package",
      name,
    ]),
    ...exportArgs,
    "--withheld-copy",
    withheld,
    "--json",
  ]);
  // A refusal prints its error; the exit code alone does not tell them apart.
  expect(
    Object.hasOwn(JSON.parse(exported.stdout) as object, "code"),
    exported.stdout,
  ).toBe(exportRefused);
  await writeFile(join(work, "draft.json"), draft.stdout);
  await writeFile(join(work, "export.json"), exported.stdout);
  return {
    capture,
    draft: join(work, "draft.json"),
    export: join(work, "export.json"),
    bundle,
    schema: join(work, "schema.json"),
    withheld,
  };
};

/**
 * A REA server whose build computers run REA's controller on this host
 * against a REA stand-in printing the real CLI's outputs. `dropReplies`
 * names controller commands, in order, whose reply is lost after they run;
 * `env` adds to the stand-in's environment; `install` replaces the captured
 * package, the archive's `notes`, and names the packages the real export
 * installs beside it; `screenshotDelaysMs` delays the computer's
 * screenshots in order. `recorded` replaces what the capture records, with
 * `exportRefused` when its export refuses BUILD_TASK, or `tasks` in its
 * place, and `extraContent` the
 * retained bytes it holds beyond the note's; `selected` is what it records
 * when given exactly the `--state-path` of `path`, under the home;
 * `serverEnv` adds to the REA server's environment, and `exportArgs` to the
 * real export's arguments.
 */
export const buildCaptureFakes = async (
  options: {
    readonly dropReplies?: string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly install?: CapturedInstall;
    readonly screenshotDelaysMs?: readonly number[];
    readonly recorded?: DesktopApplicationCapture;
    readonly exportRefused?: boolean;
    readonly extraContent?: readonly string[];
    readonly tasks?: readonly BuildTaskAtEnd[];
    readonly selected?: {
      readonly path: string;
      readonly recorded: DesktopApplicationCapture;
    };
    readonly serverEnv?: Readonly<Record<string, string>>;
    readonly exportArgs?: readonly string[];
  } = {},
) => {
  const outputs = await realCliOutputs(options.install, options.recorded, {
    ...(options.exportRefused === undefined
      ? {}
      : { exportRefused: options.exportRefused }),
    ...(options.extraContent === undefined
      ? {}
      : { extraContent: options.extraContent }),
    ...(options.tasks === undefined ? {} : { tasks: options.tasks }),
    ...(options.exportArgs === undefined
      ? {}
      : { exportArgs: options.exportArgs }),
  });
  const rea = await fakeBuildComputerRea(outputs);
  const chosen = options.selected;
  const written =
    chosen === undefined
      ? undefined
      : await realCliOutputs(options.install, chosen.recorded);
  const selected =
    chosen === undefined || written === undefined
      ? {}
      : {
          FAKE_REA_STATE_PATH: join(rea.home, chosen.path),
          FAKE_REA_SELECTED_CAPTURE: written.capture,
          FAKE_REA_SELECTED_DRAFT: written.draft,
          FAKE_REA_SELECTED_EXPORT: written.export,
          FAKE_REA_SELECTED_BUNDLE: written.bundle,
        };
  const { computer, runner } = await buildComputerFakes({
    ...(options.screenshotDelaysMs === undefined
      ? {}
      : { screenshotDelaysMs: options.screenshotDelaysMs }),
    exec: {
      home: rea.home,
      bin: rea.bin,
      env: { ...rea.env, ...selected, ...options.env },
      dropReplies: options.dropReplies ?? [],
    },
  });
  const payload = join(runner.state, "rea-prod.tar.xz");
  await writeFile(payload, "a packed REA build");
  const client = await connectBuildServer({
    ...runner.environment,
    REA_BUILD_COMPUTER_REA_ARCHIVE: payload,
    ...options.serverEnv,
  });
  return { rea, outputs, computer, client };
};
