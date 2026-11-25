import { writeFile } from "node:fs/promises";
import type { Client } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import {
  HOME,
  change,
  retained,
  seedEndCapture,
} from "../../../src/application/desktop/desktopCapture.fixture.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import type { DesktopApplicationCapture } from "../../../src/domain/desktop/desktopCapture.js";
import {
  BUILD_REQUEST as REQUEST,
  buildCaptureFakes,
} from "../../fixtures/buildCaptureFakes.js";
import { callOk, startBuildComputer } from "../../fixtures/buildComputerMcp.js";

const LIST = "Documents/list.xml";
const SEED = `<list><cat key="1" name="Dairy"/><cat key="2" name="Bakery"/><item name="milk" cat="1" qty="1"/><item name="bread" cat="2" qty="2"/></list>`;
/** The user bought more bread and added a dozen eggs, a dairy item. */
const END = `<list><cat key="1" name="Dairy"/><cat key="2" name="Bakery"/><item name="milk" cat="1" qty="1"/><item name="bread" cat="2" qty="3"/><item name="eggs" cat="1" qty="12"/></list>`;

/** The seed-and-end capture with the shopping list kept as XML, named in the window's title. */
const listCapture = (): DesktopApplicationCapture => {
  const base = seedEndCapture();
  const path = `${HOME}/${LIST}`;
  return {
    ...base,
    session: {
      ...base.session,
      windows: base.session.windows.map((window) => ({
        ...window,
        titles: ["list.xml - Notes"],
      })),
    },
    state: {
      ...base.state,
      checkpoints: base.state.checkpoints.map((point) => {
        if (point.name === "seed")
          return {
            ...point,
            changes: [change(path, { after: SEED })],
            retained: [retained(path, SEED)],
          };
        if (point.name === "end")
          return {
            ...point,
            changes: [change(path, { before: SEED, after: END })],
            retained: [retained(path, END)],
          };
        return point;
      }),
    },
  };
};

const stopDraft = async (client: Client) => {
  const id = await startBuildComputer(client, REQUEST);
  await callOk(client, "start_build_capture", { computer_id: id });
  for (const name of ["seed", "end"])
    await callOk(client, "mark_build_checkpoint", { computer_id: id, name });

  const { draft } = toolContract("stop_build_capture").outputSchema.parse(
    (await callOk(client, "stop_build_capture", { computer_id: id }))
      .structuredContent,
  );
  return draft;
};

it("returns each changed file's values, with what a value names, and guards outside the task's checks", async () => {
  const { client } = await buildCaptureFakes({
    recorded: listCapture(),
    exportRefused: true,
    extraContent: [SEED, END],
  });
  const draft = await stopDraft(client);

  const item = (name: string) => `/root/children/[name=item][@name=${name}]`;
  expect(draft?.files).toEqual([
    {
      file: LIST,
      role: "document",
      change: expect.objectContaining({ kind: "values" }),
      values: [
        {
          pointer: item("eggs"),
          kind: "added",
          before: null,
          after: '<item name="eggs" cat="1" qty="12"/>',
          refers_to: [
            {
              attribute: "cat",
              value: "1",
              element: '<cat key="1" name="Dairy"/>',
            },
          ],
        },
        {
          pointer: `${item("bread")}/attributes/qty`,
          kind: "changed",
          before: "2",
          after: "3",
        },
      ],
      values_cut: false,
    },
  ]);
  const check = (id: string, pointer: string, value: string) => ({
    id,
    kind: "value_equals",
    file: LIST,
    pointer,
    value,
  });
  expect(draft?.task.checks).toEqual([
    check("check-1", `${item("eggs")}/attributes/cat`, "1"),
    check("check-2", `${item("eggs")}/attributes/qty`, "12"),
    check("check-3", `${item("bread")}/attributes/qty`, "3"),
    // An item was added, so the list's count is a check too.
    {
      id: "check-4",
      kind: "member_count",
      file: LIST,
      pointer: "/root/children",
      matching: "[name=item]",
      equals: 3,
    },
  ]);
  // The same fields on the nearest other items, which the user left alone.
  expect(draft?.guards).toEqual([
    check("guard-1", `${item("bread")}/attributes/cat`, "2"),
    check("guard-2", `${item("milk")}/attributes/cat`, "1"),
    check("guard-3", `${item("milk")}/attributes/qty`, "1"),
  ]);
  expect(draft?.notes).toEqual([]);
});

it("projects supported guest fields and supplies missing draft defaults", async () => {
  const { client, outputs } = await buildCaptureFakes();
  const file = { file: LIST, role: "document", change: { guest_detail: 1 } };
  const task = { name: "edit", prompt: "Edit the list", checks: [] };
  const guest = createEvidence(
    unknownTarget("not-observed"),
    { id: "fixture", name: "Guest fixture", version: null },
    {
      operation: "describe_desktop_application_task",
      parameters: {},
      result: {
        seed_checkpoint: "guest-seed",
        end_checkpoint: "guest-end",
        guest_metadata: true,
        files: [{ ...file, guest_metadata: true }],
        task: { ...task, guest_metadata: true },
      },
    },
  );
  await writeFile(outputs.draft, JSON.stringify(guest));
  expect(await stopDraft(client)).toEqual({
    seed_checkpoint: "seed",
    end_checkpoint: "end",
    files: [{ ...file, values: [], values_cut: false }],
    task,
    guards: [],
    notes: [],
    withheld_files: [],
  });
});
