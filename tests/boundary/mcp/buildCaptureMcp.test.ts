import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  HOME,
  change,
  retained,
  seedEndCapture,
} from "../../../src/application/desktop/desktopCapture.fixture.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import type { DesktopApplicationCapture } from "../../../src/domain/desktop/desktopCapture.js";
import { seedWording } from "../../../src/domain/desktop/appExport.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  BUILD_REQUEST as REQUEST,
  BUILD_TASK as TASK,
  buildCaptureFakes as fakes,
} from "../../fixtures/buildCaptureFakes.js";
import {
  bundleFolder,
  callOk,
  expectNoToken,
  startBuildComputer,
} from "../../fixtures/buildComputerMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const files = async (root: string, prefix = ""): Promise<string[]> =>
  (
    await Promise.all(
      (await readdir(join(root, prefix), { withFileTypes: true })).map(
        async (entry) =>
          entry.isDirectory()
            ? files(root, join(prefix, entry.name))
            : [join(prefix, entry.name)],
      ),
    )
  )
    .flat()
    .sort();

it("captures the app inside the computer, acknowledges checkpoints, drafts the task and brings the exported bundle back", async () => {
  const { rea, outputs, computer, client } = await fakes();
  const id = await startBuildComputer(client, REQUEST);

  const started = await callOk(client, "start_build_capture", {
    computer_id: id,
  });
  expect(
    toolContract("start_build_capture").outputSchema.parse(
      started.structuredContent,
    ),
  ).toMatchObject({
    desktop_entry: "org.example.notes",
    package_lists: 1,
    package_lists_error: null,
  });
  expect(started.content.some((block) => block.type === "image")).toBe(true);

  const mark = (name: string) =>
    client.callTool({
      name: "mark_build_checkpoint",
      arguments: { computer_id: id, name },
    });
  const seed = await mark("seed");
  expect(
    toolContract("mark_build_checkpoint").outputSchema.parse(
      seed.structuredContent,
    ).checkpoint,
  ).toEqual({
    name: "seed",
    trigger: "request",
    at_ms: 1000,
    entries: 5,
    changes: 1,
    retained_files: 1,
    retained_bytes: 5,
    changed_files: ["Documents/today.txt"],
    more_changed_files: 0,
  });
  expect(parseMcpToolError(await mark("seed")).error.message).toContain(
    "already taken",
  );
  expect(parseMcpToolError(await mark("exit")).error.code).toBe(
    "invalid_request",
  );
  await callOk(client, "act_on_build_computer", {
    computer_id: id,
    action: "type",
    text: "eggs\n",
  });
  await mark("end");

  const stopped = toolContract("stop_build_capture").outputSchema.parse(
    (await callOk(client, "stop_build_capture", { computer_id: id }))
      .structuredContent,
  );
  expect(stopped.checkpoints.map(({ name }) => name)).toEqual([
    "baseline",
    "seed",
    "end",
    "stop",
    "exit",
  ]);
  expect(stopped.draft).toMatchObject({
    seed_checkpoint: "seed",
    end_checkpoint: "end",
    files: [{ file: "Documents/today.txt" }],
    task: {
      checks: [
        { kind: "lines_present", file: "Documents/today.txt", lines: ["eggs"] },
      ],
    },
  });

  const directory = join(await createTestTempDirectory("build-out-"), "notes");
  const exported = toolContract("export_build_environment").outputSchema.parse(
    (
      await callOk(client, "export_build_environment", {
        computer_id: id,
        task: TASK,
        directory,
      })
    ).structuredContent,
  );
  const { bundle } = outputs;
  expect(await files(directory)).toEqual(await files(bundle));
  for (const path of await files(directory))
    expect(
      (await readFile(join(directory, path))).equals(
        await readFile(join(bundle, path)),
      ),
      path,
    ).toBe(true);
  expect(exported).toMatchObject({
    environment: "notes",
    files: (await files(directory)).length,
    seed_files: [".config/notes/settings.ini", "Documents/today.txt"],
    task: { name: "add-eggs", failing_on_seed: [expect.any(String)] },
  });
  expect(await rea.notes("tasks.jsonl")).toEqual([TASK]);

  // REA ran as the computer's user in its home, with the user's own package
  // lists and without the control token the computer's routes take.
  const calls = (await rea.notes("calls.jsonl")) as {
    argv: string[];
    cwd: string;
    apt_config: string;
    agentenv: string[];
  }[];
  expect(calls.map(({ argv }) => argv[0])).toEqual([
    "export-desktop-application",
    "capture-desktop-application",
    "describe-desktop-application-task",
    "export-desktop-application",
  ]);
  for (const call of calls)
    expect(call).toMatchObject({
      agentenv: [],
      apt_config: join(rea.home, ".rea-build/apt/apt.conf"),
    });
  expect(calls[1]?.argv).toEqual(
    expect.arrayContaining([
      "--desktop-entry",
      "org.example.notes",
      "--exclude",
      join(rea.home, ".rea-build"),
    ]),
  );
  expect(calls.slice(2).map(({ argv }) => argv)).toEqual([
    expect.arrayContaining([
      "--seed-checkpoint",
      "seed",
      "--end-checkpoint",
      "end",
    ]),
    expect.arrayContaining([
      "--seed-checkpoint",
      "seed",
      "--end-checkpoint",
      "end",
      // The agent made the seed in the computer, so the README need not keep it local.
      "--synthetic-seed",
    ]),
  ]);
  expect(
    parseEvidence(JSON.parse(await readFile(outputs.export, "utf8")))
      .parameters,
  ).toMatchObject({ synthetic_seed: true });
  expect(await readFile(join(directory, "README.md"), "utf8")).toContain(
    seedWording({
      name: exported.environment,
      seedCheckpoint: "seed",
      syntheticSeed: true,
    }).notice,
  );
  expectNoToken(computer, [started, seed, stopped, exported]);
});

it("takes checkpoints from a REA in the computer that predates their changed files, saying which changed is unknown, also from its log", async () => {
  const { client } = await fakes({
    env: { FAKE_REA_UNLISTED_CHANGES: "1" },
    dropReplies: ["mark"],
  });
  const id = await startBuildComputer(client, REQUEST);
  await callOk(client, "start_build_capture", { computer_id: id });
  const mark = async (name: string) =>
    toolContract("mark_build_checkpoint").outputSchema.parse(
      (
        await callOk(client, "mark_build_checkpoint", {
          computer_id: id,
          name,
        })
      ).structuredContent,
    ).checkpoint;
  // The first reply is lost, so the second call reads the checkpoint from the capture's log.
  expect(
    (
      await client.callTool({
        name: "mark_build_checkpoint",
        arguments: { computer_id: id, name: "seed" },
      })
    ).isError,
  ).toBe(true);

  const seed = await mark("seed");
  const end = await mark("end");

  for (const [taken, name, atMs] of [
    [seed, "seed", 1000],
    [end, "end", 2000],
  ] as const)
    expect(taken).toEqual({
      name,
      trigger: "request",
      at_ms: atMs,
      entries: 5,
      changes: 1,
      retained_files: 1,
      retained_bytes: 5,
      changed_files: null,
      more_changed_files: null,
    });
  await callOk(client, "stop_build_capture", { computer_id: id });
});

it("returns a draft note's read error when only a dconf database REA cannot read changed between seed and end", async () => {
  const database = `${HOME}/.config/dconf/user`;
  const [before, after] = ["GVariant wrap=false", "GVariant wrap=true"];
  const base = seedEndCapture();
  const recorded: DesktopApplicationCapture = {
    ...base,
    state: {
      ...base.state,
      checkpoints: base.state.checkpoints.map((point) =>
        point.name === "baseline"
          ? {
              ...point,
              retained: [...point.retained, retained(database, before)],
            }
          : point.name === "end"
            ? {
                ...point,
                changes: [change(database, { before, after })],
                retained: [retained(database, after)],
              }
            : point,
      ),
    },
  };
  // The draft runs with no dconf on its PATH, so it cannot read the database; the note never gets eggs, so the export refuses the task.
  const { client } = await fakes({
    recorded,
    extraContent: [before, after],
    exportRefused: true,
  });
  const id = await startBuildComputer(client, REQUEST);
  await callOk(client, "start_build_capture", { computer_id: id });
  for (const name of ["seed", "end"])
    await callOk(client, "mark_build_checkpoint", { computer_id: id, name });

  const stopped = toolContract("stop_build_capture").outputSchema.parse(
    (await callOk(client, "stop_build_capture", { computer_id: id }))
      .structuredContent,
  );

  expect(stopped.draft?.files).toEqual([]);
  expect(stopped.draft?.notes).toEqual([
    {
      code: "unreadable_changes",
      message: expect.any(String),
      files: [{ file: ".config/dconf/user", role: expect.any(String) }],
      error: "dconf is not installed (dconf-cli); set REA_DCONF_COMMAND",
    },
  ]);
});

it("refuses an older build runtime before capturing the app", async () => {
  const { rea, client } = await fakes({ env: { FAKE_REA_OLD_EXPORT: "1" } });
  const id = await startBuildComputer(client, REQUEST);
  const { error } = parseMcpToolError(
    await client.callTool({
      name: "start_build_capture",
      arguments: { computer_id: id },
    }),
  );
  expect(error.message).toContain("does not support synthetic seeds");
  expect(JSON.stringify(error)).toContain("pack:build-computer-runtime");
  expect(JSON.stringify(error)).toContain("restart the REA MCP server");
  const calls = (await rea.notes("calls.jsonl")) as { argv: string[] }[];
  expect(calls.map(({ argv }) => argv[0])).not.toContain(
    "capture-desktop-application",
  );
});

it("reports an unsuccessful runtime schema command without diagnosing its cause", async () => {
  const { rea, client } = await fakes({
    env: { FAKE_REA_SCHEMA_FAILURE: "1" },
  });
  const id = await startBuildComputer(client, REQUEST);
  const { error } = parseMcpToolError(
    await client.callTool({
      name: "start_build_capture",
      arguments: { computer_id: id },
    }),
  );
  expect(error.message).toContain("exited 23");
  expect(error.message).toContain("runtime cannot load its export command");
  expect(error.message).not.toContain("does not support synthetic seeds");
  expect(JSON.stringify(error)).toContain("restart the REA MCP server");
  const calls = (await rea.notes("calls.jsonl")) as { argv: string[] }[];
  expect(calls.map(({ argv }) => argv[0])).not.toContain(
    "capture-desktop-application",
  );
});

it.each(["failure", "invalid"])(
  "redacts control tokens in %s schema output",
  async (mode) => {
    const { computer, client } = await fakes({
      env: { FAKE_REA_SCHEMA_TOKEN: mode },
    });
    const id = await startBuildComputer(client, REQUEST);
    const result = await client.callTool({
      name: "start_build_capture",
      arguments: { computer_id: id },
    });
    expect(result.isError).toBe(true);
    expectNoToken(computer, result);
    if (mode === "invalid") {
      expect(JSON.stringify(result)).not.toContain(computer.token.slice(0, 12));
      expect(JSON.stringify(result)).toContain("invalid JSON");
    } else expect(JSON.stringify(result)).toContain("runtime output");
  },
);

it("refuses a task too large for one command argument before the export runs in the computer", async () => {
  const { rea, client } = await fakes();
  const id = await startBuildComputer(client, REQUEST);
  await callOk(client, "start_build_capture", { computer_id: id });
  for (const name of ["seed", "end"])
    await callOk(client, "mark_build_checkpoint", { computer_id: id, name });
  await callOk(client, "stop_build_capture", { computer_id: id });
  const { error } = parseMcpToolError(
    await client.callTool({
      name: "export_build_environment",
      arguments: {
        computer_id: id,
        task: { ...TASK, prompt: "Add eggs. ".repeat(10 * 1024) },
        directory: join(await createTestTempDirectory("build-out-"), "b"),
      },
    }),
  );
  expect(error.code).toBe("invalid_request");
  const calls = (await rea.notes("calls.jsonl")) as { argv: string[] }[];
  expect(
    calls.some(
      ({ argv }) =>
        argv[0] === "export-desktop-application" && !argv.includes("--schema"),
    ),
  ).toBe(false);
});

it("refuses capture steps out of order and a capture of a bundle's computer", async () => {
  const bundled = await fakes();
  const fromBundle = await startBuildComputer(bundled.client, {
    kind: "bundle",
    path: await bundleFolder(),
  });
  expect(
    parseMcpToolError(
      await bundled.client.callTool({
        name: "start_build_capture",
        arguments: { computer_id: fromBundle },
      }),
    ).error.message,
  ).toContain("request");
  const { client } = await fakes();
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args }).then(parseMcpToolError);
  const id = await startBuildComputer(client, REQUEST);
  expect(
    (await call("mark_build_checkpoint", { computer_id: id, name: "seed" }))
      .error.message,
  ).toContain("No capture is running");
  expect(
    (await call("stop_build_capture", { computer_id: id })).error.message,
  ).toContain("No capture is running");
  expect(
    (
      await call("export_build_environment", {
        computer_id: id,
        task: TASK,
        directory: join(await createTestTempDirectory("build-out-"), "b"),
      })
    ).error.message,
  ).toContain("stopped capture");
});
