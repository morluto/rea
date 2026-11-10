import { join } from "node:path";

import { expect, it } from "vitest";

import {
  BREAD_NOTE,
  NEAR_EGGS_NOTE,
  severalEndsCapture,
} from "../../../src/application/desktop/desktopCapture.fixture.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  BUILD_REQUEST as REQUEST,
  BUILD_TASK as ADD_EGGS,
  buildCaptureFakes as fakes,
} from "../../fixtures/buildCaptureFakes.js";
import { callOk, startBuildComputer } from "../../fixtures/buildComputerMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const ADD_BREAD = {
  name: "add-bread",
  prompt: "Add bread to today's list and save it.",
  checks: [
    { kind: "lines_present", file: "Documents/today.txt", lines: ["bread"] },
  ],
};
const TASKS = [
  { task: ADD_EGGS, end_checkpoint: "end" },
  { task: ADD_BREAD, end_checkpoint: "end-add-bread" },
];

/** A build computer whose capture took seed, end, end-add-bread and near-add-eggs, stopped. */
const stoppedSeveral = async () => {
  const built = await fakes({
    recorded: severalEndsCapture("near-add-eggs"),
    extraContent: [BREAD_NOTE, NEAR_EGGS_NOTE],
    tasks: TASKS,
  });
  const id = await startBuildComputer(built.client, REQUEST);
  await callOk(built.client, "start_build_capture", { computer_id: id });
  for (const name of ["seed", "end", "end-add-bread", "near-add-eggs"])
    await callOk(built.client, "mark_build_checkpoint", {
      computer_id: id,
      name,
    });
  const stopped = toolContract("stop_build_capture").outputSchema.parse(
    (await callOk(built.client, "stop_build_capture", { computer_id: id }))
      .structuredContent,
  );
  return { ...built, id, stopped };
};

it("drafts each later task from the end before it, and exports every task checked at its own end", async () => {
  const { rea, client, id, stopped } = await stoppedSeveral();

  expect(stopped.draft).toMatchObject({
    seed_checkpoint: "seed",
    end_checkpoint: "end",
  });
  expect(stopped.later_drafts).toEqual([
    expect.objectContaining({
      end_checkpoint: "end-add-bread",
      draft: expect.objectContaining({
        seed_checkpoint: "end",
        end_checkpoint: "end-add-bread",
      }),
    }),
  ]);
  const directory = join(await createTestTempDirectory("build-out-"), "notes");
  const exported = toolContract("export_build_environment").outputSchema.parse(
    (
      await callOk(client, "export_build_environment", {
        computer_id: id,
        tasks: TASKS,
        directory,
      })
    ).structuredContent,
  );

  expect(exported.tasks).toEqual([
    expect.objectContaining({ name: "add-eggs", end_checkpoint: "end" }),
    expect.objectContaining({
      name: "add-bread",
      end_checkpoint: "end-add-bread",
    }),
  ]);
  expect(await rea.notes("tasks.jsonl")).toEqual([ADD_EGGS, ADD_BREAD]);
  const calls = (await rea.notes("calls.jsonl")) as { argv: string[] }[];
  expect(calls.map(({ argv }) => argv[0])).toEqual([
    "export-desktop-application",
    "capture-desktop-application",
    "describe-desktop-application-task",
    "describe-desktop-application-task",
    "export-desktop-application",
  ]);
  expect(calls[3]?.argv).toEqual(
    expect.arrayContaining([
      "--seed-checkpoint",
      "end",
      "--end-checkpoint",
      "end-add-bread",
    ]),
  );
  expect(calls[4]?.argv).toEqual(
    expect.arrayContaining([
      "--task-end",
      "add-eggs=end",
      "--task-end",
      "add-bread=end-add-bread",
    ]),
  );
});

it("refuses an export naming an end checkpoint the capture did not take, before running the export", async () => {
  const { rea, client, id } = await stoppedSeveral();

  const refused = parseMcpToolError(
    await client.callTool({
      name: "export_build_environment",
      arguments: {
        computer_id: id,
        tasks: [TASKS[0], { task: ADD_BREAD, end_checkpoint: "end-bread" }],
        directory: join(await createTestTempDirectory("build-out-"), "notes"),
      },
    }),
  );

  expect(refused.error.code).toBe("invalid_request");
  expect(refused.error.message).toContain("end-bread");
  const calls = (await rea.notes("calls.jsonl")) as { argv: string[] }[];
  expect(
    calls.some(
      ({ argv }) =>
        argv[0] === "export-desktop-application" && !argv.includes("--schema"),
    ),
  ).toBe(false);
});
