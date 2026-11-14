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
import { WITNESS_STAGES } from "../domain/desktop/buildWitness.js";
import { MEASURE_BUILD_TASK_CONTRACT } from "./desktopBuildMeasureContract.js";
import {
  draftSchema,
  EXAMPLE_LATER_TASK,
  EXAMPLE_TASK,
  exportedTaskSchema,
  MAX_BUILD_TASKS,
} from "./desktopBuildTaskSchemas.js";
import {
  COMPUTER_ACTIONS,
  computerActionInputSchema,
  screenshotOptionsSchema,
} from "../domain/desktop/computerActions.js";
import {
  desktopCheckpointSchema,
  MAX_ACKNOWLEDGED_FILES,
} from "../domain/desktop/desktopCapture.js";
import { jsonObjectSchema } from "../domain/jsonValue.js";
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
      "Start a local agentenv computer, installing/downloading app packages as needed; returns computer_id and a first screenshot. Requires Docker and REA_AGENT_ENV_COMMAND. Request sources install from Ubuntu, apt repositories or a .deb URL and add REA from REA_BUILD_COMPUTER_REA_ARCHIVE in a build-only layer. The app starts later: use start_build_capture, or its Applications > Other menu entry when no capture is active. Set source.electron to apply the export launch policy, adding --no-sandbox unless present because the container lacks Chromium user namespaces. Bundle-folder sources run their existing smoke task unchanged. Initial image builds and concurrent agentenv state updates can take minutes. screenshot selects initial region/format/quality. The computer stays reachable until close_build_computer or server shutdown; if failed-start teardown is unconfirmed, use the error's computer_id to retry close_build_computer.",
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
    description: `Act on a running build computer with ${COMPUTER_ACTIONS.join(", ")}; actions can change app state. Returns driver content/images and structured results, with each action logged. Points use the latest frame's pixels (take a screenshot first), or space norm on 0..norm_scale; count 2 double-clicks, drag path has 2..50 points, and keys names one W3C chord (ctrl+s is translated). Region screenshots crop the latest frame rather than recapture; use a full screenshot or wait with screenshot true first. After opening a menu/window, wait for its screenshot instead of taking the action's immediate one. type_secret reads the user-created handle file at ${secrets.BUILD_SECRETS_FOLDER} into a focused masked field: only the handle is recorded and no screenshot is taken, but later screenshots can expose unmasked fields. reset restores seed data through data/reset and relaunches; screenshot_error after reset does not undo it. Other actions forward the driver's arguments unchanged; refusals such as stale frames retain its message. Actions, capture steps and checks run sequentially per computer; different computers run independently.`,
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
    description: `Launch the app under capture on a request-built computer and return its open-window screenshot. Downloads package lists as the computer user to identify sources; do not open the app from its menu first. Early exit reports code, stderr tail and capture details. Documents are recognized from file names/~/ paths in window titles; supply state_paths when titles name something else. Save the seed through the app, mark_build_checkpoint ${SEED_CHECKPOINT}, make and save the requested change, mark ${END_CHECKPOINT}, then stop_build_capture.`,
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
    description: `Checkpoint the running capture under a unique name; returns acknowledged counts and up to ${String(MAX_ACKNOWLEDGED_FILES)} changed files. Files named by window titles rank first, then state_paths/open files, with caches last. Mark ${SEED_CHECKPOINT} after saving the seed and ${END_CHECKPOINT} after saving the first change. For later tasks, build on the preceding change and mark ${END_CHECKPOINT}-<task name>; mark near-<task name> after saving a near miss that must fail one task check. Duplicate names are refused.`,
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
    description: `Close the captured app and finish its capture. Returns checkpoints, package/sources, limitations and a draft between ${SEED_CHECKPOINT} and ${END_CHECKPOINT} when both exist and no declared secret was used. later_drafts contains one draft per later ${END_CHECKPOINT}-<task name>, relative to the preceding end checkpoint. Drafts list owned-path changes, supported before/after structured values, suggested checks and optional unchanged-state guards. Notes explain missing/thin drafts and recovery: add unrecognized documents to state_paths, or make a change saved in a readable file rather than only dconf. After secret use, automatic drafting is withheld; write the tasks manually. Otherwise write each task from its draft in the user's words and pass the tasks to export_build_environment.`,
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
      draft: draftSchema.nullable(),
      draft_refusal: z.string().optional(),
      later_drafts: z
        .array(
          z.strictObject({
            end_checkpoint: z.string(),
            draft: draftSchema.nullable(),
            draft_refusal: z.string().optional(),
          }),
        )
        .describe(
          `One draft per later task's ${END_CHECKPOINT}-<task name> checkpoint taken after ${END_CHECKPOINT}, from the end checkpoint before it, so it shows only that task's change; empty for one task.`,
        ),
    }),
    examples: [
      { title: "Stop and draft the task", input: { computer_id: EXAMPLE_ID } },
    ],
  },
  {
    name: "export_build_environment",
    ...toolContractMetadata("export_build_environment"),
    kind: "application",
    description: `Export the stopped capture and given tasks as an agentenv app bundle, seeded at ${SEED_CHECKPOINT}. Each task uses its selected end checkpoint (${END_CHECKPOINT} by default) and its captured near-<task name> when present. The bundle's eval lists every task; verified files are copied to a new/empty host directory. Refuses publication if names or contents contain declared secrets, including UTF-16/hex/base64/URL/gzip forms; errors identify handles and files. ${secrets.WITHHELD_EXPORT_DESCRIPTION} A check already passing on the seed or a near miss passing every check refuses the whole export, naming the task and reason. Witness each task on a fresh computer with start_build_computer and check_build_task.`,
    inputSchema: z.strictObject({
      computer_id: computerId,
      tasks: z
        .array(
          z.strictObject({
            task: desktopTaskSchema,
            end_checkpoint: buildCheckpointNameSchema
              .optional()
              .describe(
                `The checkpoint marked once this task's change was saved: ${END_CHECKPOINT} by default, ${END_CHECKPOINT}-<task name> for a later task.`,
              ),
          }),
        )
        .min(1)
        .max(MAX_BUILD_TASKS)
        .describe(
          "The tasks, each with its own name; the first is usually the one checked at end.",
        ),
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
      tasks: z
        .array(exportedTaskSchema)
        .describe(
          "Each task the export kept: its checks, its end checkpoint, those failing on the seed and those failing at its near miss.",
        ),
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
          tasks: [{ task: EXAMPLE_TASK }],
          directory: "/tmp/mousepad-bundle",
        },
      },
      {
        title: "Export two tasks, the second checked at its own end",
        input: {
          computer_id: EXAMPLE_ID,
          tasks: [{ task: EXAMPLE_TASK }, EXAMPLE_LATER_TASK],
          directory: "/tmp/mousepad-bundle",
        },
      },
    ],
  },
  {
    name: "check_build_task",
    ...toolContractMetadata("check_build_task"),
    kind: "application",
    description: `Evaluate saved-state task checks or run a screen_judge through its configured model endpoint on a running exported app. Returns per-check results, settling status and optional witness state. Reads data/get after files settle using exported verifier semantics; screen_judge captures the screen and uses the agentenv runner with three votes per question. Reads every ${String(SETTLE_TIMING.intervalMs / 1000)} s, waits for ${String(SETTLE_TIMING.windowMs / 1000)} s of stable bytes, and bounds observation at ${String(SETTLE_TIMING.boundMs / 1000)} s; unsettled results use the last completed read, with read_cut for interrupted reads. Witness stages run in order: seed (supply directory to begin recording) must fail a check, after_edit must pass all, near_miss must fail one, and after_reset must restore every seed result. Use the task prompt alone for the edit. Seed rejects exported task/verifier mismatches. Unreadable or truncated views are undecided, not witnessed failures; an undecidable stage is refused for retry. A failed stage or after_reset ends recording and writes witness.json plus recording segments to directory.`,
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
      "Tear down a build computer and discard its state, cancelling its active call and refusing queued calls. Tries agentenv first, then REA_DOCKER_COMMAND on only that sandbox's named/labelled containers. Unconfirmed teardown reports remaining resources and retains the computer for another close attempt.",
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
  MEASURE_BUILD_TASK_CONTRACT,
] as const satisfies readonly ToolContract[];
