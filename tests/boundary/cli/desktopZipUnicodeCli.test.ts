import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  EDITED_NOTE,
  HOME,
  change,
  retained,
  seedEndCapture,
  writeCaptureFolder,
} from "../../../src/application/desktop/desktopCapture.fixture.js";
import {
  unicodePathExtra,
  zipArchive,
} from "../../../src/domain/desktop/zipArchive.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { serveCli as serve } from "./cliServeHarness.js";

/** The plate archive's path in the capture, and the task's file. */
const PLATE = `${HOME}/Documents/plate.FCStd`;
const PLATE_FILE = "Documents/plate.FCStd";

/** An ordinary seed archive holding settings.json. */
const seedArchive = zipArchive([
  { name: "settings.json", data: '{"zoom": 1.5}' },
]);

/**
 * The end archive that still holds settings.json, behind two version-1,
 * CRC-matching Unicode Path fields: the first claims a directory, the second
 * the file the complete decoder reads.
 */
const conflictingArchive = (data: string) =>
  zipArchive([
    {
      name: "settings.json",
      data,
      centralExtra: Buffer.concat([
        unicodePathExtra("settings.json", "hidden/"),
        unicodePathExtra("settings.json", "settings.json"),
      ]),
    },
  ]);

/** A capture whose seed holds the ordinary archive and whose end holds `endArchive` instead. */
const captureWithPlate = async (endArchive: Buffer) => {
  const base = seedEndCapture();
  const capture = {
    ...base,
    state: {
      ...base.state,
      checkpoints: base.state.checkpoints.map((point) => {
        if (point.name === "seed")
          return {
            ...point,
            changes: [...point.changes, change(PLATE, { after: seedArchive })],
            retained: [...point.retained, retained(PLATE, seedArchive)],
          };
        if (point.name === "end")
          return {
            ...point,
            changes: [
              ...point.changes,
              change(PLATE, { before: seedArchive, after: endArchive }),
            ],
            retained: [...point.retained, retained(PLATE, endArchive)],
          };
        return point;
      }),
    },
  };
  return writeCaptureFolder(capture, undefined, [
    EDITED_NOTE,
    seedArchive,
    endArchive,
  ]);
};

/** Export the capture with one task file, at the seed and end checkpoints. */
const exportWithTask = async (folder: string, task: unknown, root: string) => {
  const taskFile = join(root, "task.json");
  await writeFile(taskFile, `${JSON.stringify(task, null, 2)}\n`);
  return serve([
    "export-desktop-application",
    folder,
    join(root, "bundle"),
    "--seed-checkpoint",
    "seed",
    "--end-checkpoint",
    "end",
    "--task",
    taskFile,
    "--json",
  ]);
};

it("refuses a removal task for a member the end archive still holds behind conflicting Unicode Path fields", async () => {
  const root = await createTestTempDirectory("desktop-zip-unicode-cli-");
  const folder = await captureWithPlate(conflictingArchive('{"zoom": 1.5}'));
  const refused = await exportWithTask(
    folder,
    {
      name: "remove-settings",
      prompt: "Remove settings.json from the plate archive.",
      checks: [
        {
          id: "removed",
          kind: "value_absent",
          file: PLATE_FILE,
          pointer: "/entries/[name=settings.json]",
        },
      ],
    },
    root,
  );

  expect(refused.exitCode, refused.stdout).toBe(1);
  expect(JSON.parse(refused.stdout)).toMatchObject({
    code: "invalid_request",
    details: {
      issues: [
        {
          path: ["task"],
          message: expect.stringContaining(
            'Check "removed" fails on the captured end state',
          ),
        },
      ],
    },
  });
});

it("exports a real change to the same member through the conflicting fields", async () => {
  const root = await createTestTempDirectory("desktop-zip-unicode-cli-");
  const folder = await captureWithPlate(conflictingArchive('{"zoom": 2}'));
  const exported = await exportWithTask(
    folder,
    {
      name: "zoom-in",
      prompt: "Set the plate zoom to 2.",
      checks: [
        {
          id: "zoom",
          kind: "value_equals",
          file: PLATE_FILE,
          pointer: "/entries/[name=settings.json]/view/zoom",
          value: 2,
        },
      ],
    },
    root,
  );

  expect(exported.exitCode, exported.stdout).toBe(0);
  expect(
    parseEvidence(JSON.parse(exported.stdout)).normalized_result,
  ).toMatchObject({
    tasks: [{ name: "zoom-in", failing_on_seed: ["zoom"] }],
  });
});
