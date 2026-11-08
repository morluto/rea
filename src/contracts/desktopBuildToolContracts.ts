import { z } from "zod";

import { buildSourceSchema } from "../domain/desktop/appBuild.js";
import { SETTLE_TIMING } from "../domain/desktop/appSettle.js";
import { desktopTaskSchema } from "../domain/desktop/appTask.js";
import {
  buildCheckpointNameSchema,
  buildStatePathSchema,
  END_CHECKPOINT,
  MAX_BUILD_STATE_PATHS,
  SEED_CHECKPOINT,
} from "../domain/desktop/buildCapture.js";
import { draftNoteSchema } from "../domain/desktop/appTaskDraftNotes.js";
import { draftValueSchema } from "../domain/desktop/appTaskDraftValues.js";
import { WITNESS_STAGES } from "../domain/desktop/buildWitness.js";
import {
  COMPUTER_ACTIONS,
  computerActionInputSchema,
  screenshotOptionsSchema,
} from "../domain/desktop/computerActions.js";
import {
  desktopCheckpointSchema,
  MAX_ACKNOWLEDGED_FILES,
} from "../domain/desktop/desktopCapture.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../domain/jsonValue.js";
import { absoluteLocalPathStringSchema } from "../domain/localPath.js";
import type { ToolContract } from "./toolContractTypes.js";
import * as secrets from "./desktopBuildSecretsContract.js";
import { toolContractMetadata } from "./toolEffects.js";

const computerId = z.uuid().describe("The id start_build_computer returned.");
const driverResult = jsonObjectSchema
  .nullable()
  .describe(
    "The driver's structured result, such as frame_id, width and height; null when it returned none.",
  );
const EXAMPLE_ID = "00000000-0000-4000-8000-000000000001";
const EXAMPLE_TASK: Readonly<Record<string, JsonValue>> = {
  name: "add-eggs",
  prompt:
    "In Mousepad, add eggs to the shopping list in Documents/todo.txt and save it.",
  checks: [
    { kind: "lines_present", file: "Documents/todo.txt", lines: ["eggs"] },
  ],
};
const checkResult = z.strictObject({
  id: z.string(),
  passed: z.boolean(),
  description: z.string(),
  undecided: z
    .literal(true)
    .optional()
    .describe(
      "Present on a failure for want of a readable or whole view, such as a file the app could not read just then or a view cut short; it shows nothing about the task, so a witness stage counts no such failure.",
    ),
});
const settledField = z
  .boolean()
  .describe(
    `Whether the app's files had held for ${String(SETTLE_TIMING.windowMs / 1000)} s, counted from the read that returned them, when they were graded; false when they were still changing ${String(SETTLE_TIMING.boundMs / 1000)} s after the first read began, and the last completed read was graded.`,
  );
const readCutField = z
  .boolean()
  .describe(
    `Whether a read still in flight ${String(SETTLE_TIMING.boundMs / 1000)} s after the first read began was cut there, so the last completed read was graded.`,
  );
const strings = z.array(z.string());
const stageRecord = z.strictObject({
  stage: z.enum(WITNESS_STAGES),
  actions_before: z
    .int()
    .nonnegative()
    .describe("How many logged actions came before this stage's check."),
  checked_at: z.string(),
  expectation: z.enum(["some_fail", "all_pass"]),
  held: z.boolean(),
  settled: settledField,
  read_cut: readCutField,
  results: z.array(checkResult),
  remediation: z
    .string()
    .optional()
    .describe(
      "Why the stage did not hold when its results alone do not say, such as a reset that did not restore the seed, and what to do.",
    ),
});
const loggedAction = z.strictObject({
  index: z.int().nonnegative(),
  action: z.enum(COMPUTER_ACTIONS),
  tool: z.string(),
  arguments: jsonObjectSchema,
  truncated_arguments: z
    .array(z.string())
    .optional()
    .describe(
      "Arguments this entry cuts, each string to 1 KiB and each list to 64 items; the computer received them whole.",
    ),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  outcome: z.enum(["pending", "applied", "refused", "failed"]),
});
const witnessRecord = z.strictObject({
  path: z.string().describe("witness.json, the record as REA Evidence."),
  evidence_id: z.string(),
  verdict: z.enum(["held", "failed"]),
  failed_stage: z.enum(WITNESS_STAGES).nullable(),
  task: z.strictObject({ name: z.string(), sha256: z.string() }),
  stages: z.array(stageRecord),
  actions: z
    .array(loggedAction)
    .describe(
      "The latest actions logged on the computer, up to 256 within 256 KiB, oldest first.",
    ),
  actions_dropped: z
    .int()
    .nonnegative()
    .describe(
      "How many of the earliest logged actions the log no longer keeps; the stages' rules counted them.",
    ),
  recording: z.union([
    z.strictObject({
      recording_id: z.string(),
      segments: z.array(
        z.strictObject({
          path: z.string().describe("Relative to the witness folder."),
          bytes: z.int().nonnegative(),
          sha256: z.string(),
        }),
      ),
    }),
    z.strictObject({ error: z.string() }),
  ]),
});

/** Session tools that keep an agentenv computer up and forward computer-use actions to it while an environment is built. */
export const DESKTOP_BUILD_TOOL_CONTRACTS = [
  {
    name: "start_build_computer",
    ...toolContractMetadata("start_build_computer"),
    kind: "application",
    description:
      "Start a local agentenv computer to build a desktop app environment on, and return its id with a first screenshot as an image. From a request, REA renders a bundle that installs the app from the Ubuntu archive, an apt repository or a .deb URL, opens it on demand from its desktop entry (it is not open at first: start_build_capture opens it under capture, and only when no capture is under way is it opened from the desktop's Applications menu, under Other, by the environment's name), and installs REA itself in a build-only layer from REA_BUILD_COMPUTER_REA_ARCHIVE. Set source.electron for an Electron app: the install rewrites that desktop entry's command with the same launch policy an export uses, adding --no-sandbox right after the program unless the command already has it, because the container does not grant the user namespaces Chromium needs and Electron exits without the flag. From a bundle folder, such as an exported one, it starts that bundle's smoke task as it is. Needs Docker and the agentenv runner named by REA_AGENT_ENV_COMMAND; the first start of a bundle builds its image, which downloads packages and can take minutes, and agentenv makes a start wait while another agentenv run on this host writes its bundle's ids, so starts at the same time can wait minutes for each other. screenshot sets the first screenshot's region, format and quality. The computer stays up, reachable on this host, until close_build_computer or the server closes; when a start fails before its teardown is confirmed, the error's computer_id names what close_build_computer retries.",
    inputSchema: z.strictObject({
      source: buildSourceSchema,
      screenshot: screenshotOptionsSchema.optional(),
    }),
    outputSchema: z.strictObject({
      computer_id: z.uuid(),
      sandbox_id: z.string().describe("agentenv's sandbox id."),
      environment: z
        .string()
        .describe("The rendered environment's name, or the bundle folder."),
      extra_packages: z
        .array(z.string())
        .describe(
          "The packages the request named beside the app, which the export installs beside it too: an archive install's extra_packages or a package file's dependencies; empty otherwise.",
        ),
      screenshot: driverResult,
    }),
    examples: [
      {
        title: "Build Mousepad from the Ubuntu archive",
        input: {
          source: {
            kind: "request",
            desktop_entry: "org.xfce.mousepad",
            install: { kind: "archive", package: "mousepad" },
          },
        },
      },
      {
        title: "Start an exported bundle",
        input: { source: { kind: "bundle", path: "/tmp/mousepad-bundle" } },
      },
    ],
  },
  {
    name: "act_on_build_computer",
    ...toolContractMetadata("act_on_build_computer"),
    kind: "application",
    description: `Drive the app on a build computer: one action, ${COMPUTER_ACTIONS.join(", ")}. Each but reset and type_secret is sent to the computer's computer_<action> tool with the fields given, which are the driver's own arguments; type_secret types into the focused field the value of the secret its handle names, a file the person wrote in REA's build-secrets folder on this host (${secrets.BUILD_SECRETS_FOLDER}), readable only by them: no result, log or record shows the value, only the handle, so it takes no screenshot, and the field must be one that masks what is typed, since a later screenshot shows the screen; reset restores the app's data to its seed with data/reset, which relaunches the app, and returns once the computer is ready again; a screenshot asked of it that then fails leaves the reset done, its result naming why in screenshot_error. Points are pixels of the latest frame, so take a screenshot first, or space norm on a 0..norm_scale grid; count 2 double-clicks; a drag's path takes 2 to 50 points; a screenshot with region does not capture the screen again, it crops the latest frame, so take a full screenshot, or a wait with screenshot true, first; keys names one chord in W3C names, and spellings such as ctrl+s are translated. Returns the driver's content unchanged, its images included, and its structured result; an action's screenshot is taken at once, so after one that opens a menu or a window, take it with a wait instead; a refusal, such as a stale frame, is an error with the computer's message. Each action is logged on the computer. Actions, capture steps and checks on one computer run one at a time, in the order they arrive; computers run side by side.`,
    inputSchema: computerActionInputSchema,
    outputSchema: z.strictObject({
      computer_id: z.uuid(),
      action: z.enum(COMPUTER_ACTIONS),
      action_index: z
        .int()
        .nonnegative()
        .describe("The action's place in the computer's action log."),
      result: driverResult,
    }),
    examples: [
      {
        title: "Look at the screen",
        input: { computer_id: EXAMPLE_ID, action: "screenshot" },
      },
      {
        title: "Double-click a point of the latest frame",
        input: {
          computer_id: EXAMPLE_ID,
          action: "click",
          x: 640,
          y: 400,
          count: 2,
        },
      },
      {
        title: "Save",
        input: {
          computer_id: EXAMPLE_ID,
          action: "key",
          keys: ["Control", "s"],
        },
      },
      secrets.TYPE_SECRET_EXAMPLE,
    ],
  },
  {
    name: "start_build_capture",
    ...toolContractMetadata("start_build_capture"),
    kind: "application",
    description: `Begin REA's capture of the app on a build computer started from a request, inside the computer: REA downloads the package lists as the computer's user so the capture finds the app's sources, launches the app from its desktop entry under capture (do not open it from the menu first) and returns once its window is open, with a screenshot. When the app exits before its window opens, the error gives its exit code and the end of its stderr, with the capture's record of the session in its details. REA counts a file as the app's document when an app window's title shows its name or ~/ path; name the file the app will save in state_paths when its title shows something else, such as a score's title. Then make the seed through the app and save it, mark_build_checkpoint ${SEED_CHECKPOINT}, make the change the task asks for and save it, mark_build_checkpoint ${END_CHECKPOINT}, and stop_build_capture.`,
    inputSchema: z.strictObject({
      computer_id: computerId,
      arguments: z
        .array(z.string().max(4096))
        .max(32)
        .optional()
        .describe(
          "Arguments appended to the app's launch command, such as a file to open.",
        ),
      state_paths: z
        .array(buildStatePathSchema)
        .max(MAX_BUILD_STATE_PATHS)
        .optional()
        .describe(
          "Files or folders in the computer's home that hold the app's state, relative to the home (Documents/Scores/song.mscz), after ~/ or absolute under it; they need not exist yet. The capture retains them from its start and counts their files as the app's: a document, which the bundle owns, seeds and opens at launch when it is the seed's only one, or the app's own state under a hidden folder such as .config/MuseScore. An absolute path outside the home is refused.",
        ),
    }),
    outputSchema: z.strictObject({
      computer_id: z.uuid(),
      desktop_entry: z.string(),
      package_lists: z
        .int()
        .nonnegative()
        .describe(
          "apt package lists found for the capture to read sources from.",
        ),
      package_lists_error: z
        .string()
        .nullable()
        .describe("Why downloading the package lists failed, if it did."),
      screenshot: driverResult,
    }),
    examples: [
      {
        title: "Capture the requested app",
        input: { computer_id: EXAMPLE_ID },
      },
      {
        title: "Capture an app whose title shows a score's title, not its file",
        input: {
          computer_id: EXAMPLE_ID,
          state_paths: ["Documents/MuseScore3/Scores/Morning_Song.mscz"],
        },
      },
    ],
  },
  {
    name: "mark_build_checkpoint",
    ...toolContractMetadata("mark_build_checkpoint"),
    kind: "application",
    description: `Take a named checkpoint of the app's state in the capture under way and wait for the capture to acknowledge it, with its counts (entries walked, paths changed since the checkpoint before, files retained) and up to ${String(MAX_ACKNOWLEDGED_FILES)} of the files that changed, those a window title named first, then those under state_paths and those the app held open, caches last, so you can see which file a save wrote. Mark ${SEED_CHECKPOINT} once the seed is saved and ${END_CHECKPOINT} once the change is; a name already taken is refused.`,
    inputSchema: z.strictObject({
      computer_id: computerId,
      name: buildCheckpointNameSchema,
    }),
    outputSchema: z.strictObject({
      computer_id: z.uuid(),
      checkpoint: z.strictObject({
        name: z.string(),
        trigger: desktopCheckpointSchema.shape.trigger,
        at_ms: z.int().nonnegative(),
        entries: z.int().nonnegative(),
        changes: z.int().nonnegative(),
        retained_files: z.int().nonnegative(),
        retained_bytes: z.int().nonnegative(),
        changed_files: z
          .array(z.string())
          .max(MAX_ACKNOWLEDGED_FILES)
          .nullable()
          .describe(
            "Files, not folders, changed since the checkpoint before, relative to the home: those an app window's title has named, those named themselves in state_paths, those the app held open, under a selected folder or in its state directories, the rest, then caches and browser-engine storage, each by path. null when the REA in the computer is older and does not report them, so which files changed is unknown; the checkpoint was still taken.",
          ),
        more_changed_files: z
          .int()
          .nonnegative()
          .nullable()
          .describe(
            "How many more files changed than changed_files names; null when changed_files is.",
          ),
      }),
    }),
    examples: [
      {
        title: "Mark the saved seed",
        input: { computer_id: EXAMPLE_ID, name: SEED_CHECKPOINT },
      },
    ],
  },
  {
    name: "stop_build_capture",
    ...toolContractMetadata("stop_build_capture"),
    kind: "application",
    description: `Stop the capture: the app is closed and the capture finishes inside the computer. Returns its checkpoints, the package and sources it found, its limitations and, when ${SEED_CHECKPOINT} and ${END_CHECKPOINT} were marked, the task draft between them: the files that changed under the paths the bundle owns, each with its net change and, for XML files, archives, JSON and key files, the values it added, changed and removed (before and after, at the pointers a check names them by); suggested checks; and guards, optional checks that the rest stays as it was. Notes say why a draft is empty (nothing changed; the changes lie outside the owned paths, listed with their roles; the app saved its change only in dconf, which no check reads; a dconf database changed that REA could not read; or REA recognized no document: capture again with state_paths naming the file, or make a change the app saves in a file) or why a file's suggestions are thin (only position names the change, it is all view state, its text is too long, or its view is cut or unreadable). Write the task from the draft, its prompt in the user's words, and give it to export_build_environment.`,
    inputSchema: z.strictObject({ computer_id: computerId }),
    outputSchema: z.strictObject({
      computer_id: z.uuid(),
      end_reason: z.string(),
      checkpoints: z.array(
        z.strictObject({
          name: z.string(),
          trigger: z.string(),
          changes: z.int().nonnegative(),
          retained_files: z.int().nonnegative(),
        }),
      ),
      package: z.strictObject({
        kind: z.string(),
        name: z.string().nullable(),
        version: z.string().nullable(),
        sources: strings,
      }),
      limitations: strings,
      draft: z
        .strictObject({
          seed_checkpoint: z.string(),
          end_checkpoint: z.string(),
          files: z.array(
            z.strictObject({
              file: z.string(),
              role: z.string(),
              change: jsonValueSchema,
              values: z
                .array(draftValueSchema)
                .describe(
                  "The values the change added, changed and removed, ready to copy into a check: what a check can name first, then what only position reaches, then noise; at most 20 entries and 8 KB a file and 24 KB a draft. Only XML files, archives, JSON and key files have values: a text file's or SQLite database's change already lists its lines and rows.",
                ),
              values_cut: z
                .boolean()
                .describe("Whether a limit left values out."),
            }),
          ),
          task: z.strictObject({
            name: z.string(),
            prompt: z.string(),
            checks: z.array(jsonObjectSchema),
          }),
          guards: z
            .array(jsonObjectSchema)
            .describe(
              "Optional checks that the rest keeps its seed value, which the end holds too: a field on like siblings, one that varies among them before a default they all share; the text an addition kept; a text file's lines beside its new one. Add those worth keeping to the task's checks.",
            ),
          notes: z
            .array(draftNoteSchema)
            .describe(
              "Why the draft has no files, or why a file's suggested checks are thin; empty when neither.",
            ),
          withheld_files: secrets.draftWithheldField,
        })
        .nullable(),
      draft_refusal: z.string().optional(),
    }),
    examples: [
      { title: "Stop and draft the task", input: { computer_id: EXAMPLE_ID } },
    ],
  },
  {
    name: "export_build_environment",
    ...toolContractMetadata("export_build_environment"),
    kind: "application",
    description: `Export the stopped capture as an agentenv computer app bundle with the given task, inside the computer, seeded at ${SEED_CHECKPOINT} and checked at ${END_CHECKPOINT}, then copy the bundle to a new or empty folder on this host, every file checked against its digest. A bundle whose file names or contents hold a secret from REA's build-secrets folder, as it is, in UTF-16, hex, base64, URL encoding or inside a gzip file, is refused and written nowhere, the error naming the secrets' handles and the files. ${secrets.WITHHELD_EXPORT_DESCRIPTION} A task the export refuses, such as a check that already passes on the seed, is an error naming why. Witness the bundle next: start_build_computer from the folder and check_build_task.`,
    inputSchema: z.strictObject({
      computer_id: computerId,
      task: desktopTaskSchema,
      directory: absoluteLocalPathStringSchema.describe(
        "A new or empty folder on this host for the bundle.",
      ),
      name: z
        .string()
        .min(1)
        .optional()
        .describe("The environment's name; derived from the app by default."),
      ...secrets.withholdInputFields,
    }),
    outputSchema: z.strictObject({
      computer_id: z.uuid(),
      directory: z.string(),
      environment: z.string(),
      files: z.int().nonnegative(),
      bytes: z.int().nonnegative(),
      // The export's task summary: its name, checks and those failing on the seed.
      task: jsonValueSchema,
      seed_files: strings,
      scrubbed_files: strings,
      // gzip seeds compressed again only to clear their headers, their documents as captured.
      recompressed_files: strings,
      unscrubbed_files: strings,
      limitations: strings,
      ...secrets.withheldOutputFields,
    }),
    examples: [
      {
        title: "Export the bundle with the task",
        input: {
          computer_id: EXAMPLE_ID,
          task: EXAMPLE_TASK,
          directory: "/tmp/mousepad-bundle",
        },
      },
    ],
  },
  {
    name: "check_build_task",
    ...toolContractMetadata("check_build_task"),
    kind: "application",
    description: `Grade a task's checks against the app's live state on a computer of an exported bundle: REA reads the app's data/get views and evaluates each check as the bundle's verifier does, one result per check, once the app's files settle: it reads data/get every ${String(SETTLE_TIMING.intervalMs / 1000)} s and grades once every file has held for ${String(SETTLE_TIMING.windowMs / 1000)} s, counted from the read that returned its bytes, so an app that saves a few seconds after the last key is graded on what it saved; no read begins ${String(SETTLE_TIMING.boundMs / 1000)} s or more after the first one began, one still in flight then is cut (read_cut), and files still changing are graded on the last completed read, with settled false. With stage, the check is part of the witness, in order: seed (give directory; REA begins recording) must fail a check, and on a computer started from a bundle folder it refuses a task whose steps and verifier in the bundle differ from what the export writes for it; after_edit, after acting on the app from the task's prompt alone, must pass every check; near_miss, after a deliberately almost-right change, must fail one; after_reset, after act_on_build_computer action reset, must give each check the result it had on the seed. Only a check that fails on what the app's view shows counts as failing: one that fails because the view could not be read or is cut short is undecided, and a stage only undecided checks would settle files nothing and is refused, to be checked again. A stage that does not hold, or after_reset, ends the witness: REA ends the recording and writes witness.json, the record as Evidence, with the recording's segments into directory, and returns the record.`,
    inputSchema: z.strictObject({
      computer_id: computerId,
      task: desktopTaskSchema,
      stage: z
        .enum(WITNESS_STAGES)
        .optional()
        .describe(
          "The witness stage this check files; none for a plain check.",
        ),
      directory: absoluteLocalPathStringSchema
        .optional()
        .describe(
          "seed only: a new or empty folder on this host for the record and recording.",
        ),
    }),
    outputSchema: z.strictObject({
      computer_id: z.uuid(),
      task: z.string(),
      passed: z.int().nonnegative(),
      failed: z.int().nonnegative(),
      results: z.array(checkResult),
      settled: settledField,
      read_cut: readCutField,
      witness: z
        .strictObject({
          stage: z.enum(WITNESS_STAGES),
          expectation: z.enum(["some_fail", "all_pass"]),
          held: z.boolean(),
          status: z.enum(["open", "held", "failed"]),
          next_stage: z.enum(WITNESS_STAGES).nullable(),
          record: witnessRecord.nullable(),
        })
        .nullable(),
    }),
    examples: [
      {
        title: "Check the seed and begin the witness",
        input: {
          computer_id: EXAMPLE_ID,
          task: EXAMPLE_TASK,
          stage: "seed",
          directory: "/tmp/mousepad-witness",
        },
      },
    ],
  },
  secrets.RECORD_BUILD_CONSENT_CONTRACT,
  {
    name: "close_build_computer",
    ...toolContractMetadata("close_build_computer"),
    kind: "application",
    description:
      "Tear a build computer down and discard its state. agentenv's teardown is tried first; if it leaves the computer up, REA removes that exact sandbox's containers, the one named agent-<sandbox id> and any labelled agentenv.sandbox=<sandbox id>, with REA_DOCKER_COMMAND. When neither confirms it, the error names what is left and the computer stays listed, so closing again retries. Closing cancels the call in progress on the computer and refuses those waiting for it.",
    inputSchema: z.strictObject({ computer_id: computerId }),
    outputSchema: z.strictObject({
      computer_id: z.uuid(),
      teardown: z
        .enum(["agentenv", "container_label"])
        .describe("What confirmed the computer is gone."),
    }),
    examples: [
      {
        title: "Close a build computer",
        input: { computer_id: EXAMPLE_ID },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
