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

/** The app's package as the capture records it, the URL the export downloads its file from, if it needs one, and the packages it installs beside the app. */
export interface CapturedInstall {
  readonly package?: DesktopPackage;
  readonly packageUrl?: string;
  readonly extraPackages?: readonly string[];
}

/**
 * What the real CLI writes for a capture made between seed and end, by
 * default `seedEndCapture`: the draft, and the export with BUILD_TASK, which
 * must succeed unless `exportRefused`.
 */
const realCliOutputs = async (
  install: CapturedInstall | undefined,
  recorded: DesktopApplicationCapture = seedEndCapture(),
  {
    exportRefused = false,
    content = [],
  }: { exportRefused?: boolean; content?: readonly string[] } = {},
) => {
  const capture = await writeCaptureFolder(
    install?.package === undefined
      ? recorded
      : {
          ...recorded,
          application: { ...recorded.application, package: install.package },
        },
    undefined,
    [EDITED_NOTE, ...content],
  );
  const work = await createTestTempDirectory("build-cli-");
  const task = join(work, "task.json");
  await writeFile(task, JSON.stringify(BUILD_TASK));
  const bundle = join(work, "bundle");
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
    "--task",
    task,
    ...ENDS,
    "--synthetic-seed",
    ...(install?.packageUrl === undefined
      ? []
      : ["--package-url", install.packageUrl]),
    ...(install?.extraPackages ?? []).flatMap((name) => [
      "--extra-package",
      name,
    ]),
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
 * `exportRefused` when its export refuses BUILD_TASK and `content` the files
 * it retained beyond the note's; `selected` is what it records when given
 * exactly the `--state-path` of `path`, under the home.
 */
export const buildCaptureFakes = async (
  options: {
    readonly dropReplies?: string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly install?: CapturedInstall;
    readonly screenshotDelaysMs?: readonly number[];
    readonly recorded?: DesktopApplicationCapture;
    readonly exportRefused?: boolean;
    readonly content?: readonly string[];
    readonly selected?: {
      readonly path: string;
      readonly recorded: DesktopApplicationCapture;
    };
  } = {},
) => {
  const outputs = await realCliOutputs(options.install, options.recorded, {
    ...(options.exportRefused === undefined
      ? {}
      : { exportRefused: options.exportRefused }),
    ...(options.content === undefined ? {} : { content: options.content }),
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
  });
  return { rea, outputs, computer, client };
};
