import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import type { CallToolResult } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";

import { isPortableBundleName } from "../../../src/application/environment/environmentBundle.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseDesktopTask } from "../../../src/domain/desktop/appTask.js";
import {
  renderTaskSteps,
  renderTaskVerifier,
  taskVerifierArtifact,
} from "../../../src/domain/desktop/appTaskPython.js";
import {
  BUILD_REQUEST as REQUEST,
  BUILD_TASK as TASK,
  buildCaptureFakes,
} from "../../fixtures/buildCaptureFakes.js";
import {
  buildComputerFakes,
  bundleFolder,
  callOk,
  connectBuildServer,
  startBuildComputer,
} from "../../fixtures/buildComputerMcp.js";
import type { FakeApp } from "../../fixtures/fakeAgentEnvComputer.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// Made-up values, never real credentials.
const VALUE = "e-Plum7-Kite-Throwaway-42";

/** An XDG config folder whose REA secrets folder holds `files` by handle, each with its mode. */
const secretsConfig = async (
  files: Readonly<Record<string, { text: string; mode?: number }>>,
) => {
  const config = await createTestTempDirectory("xdg-config-");
  const folder = join(config, "rea", "build-secrets");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  for (const [handle, { text, mode = 0o600 }] of Object.entries(files)) {
    await writeFile(join(folder, handle), text);
    await chmod(join(folder, handle), mode);
  }
  return config;
};

const errorMessage = (result: unknown) =>
  parseMcpToolError(result as CallToolResult).error.message;

it("types a secret from its handle's file, showing neither its value nor an image, and refuses unsafe handles", async () => {
  const { computer, runner } = await buildComputerFakes();
  const config = await secretsConfig({
    master: { text: `${VALUE}\n` },
    shared: { text: VALUE, mode: 0o644 },
  });
  const client = await connectBuildServer({
    ...runner.environment,
    XDG_CONFIG_HOME: config,
  });
  const id = await startBuildComputer(client, {
    kind: "bundle",
    path: await bundleFolder(),
  });
  const act = (action: string, fields: Record<string, unknown> = {}) =>
    client.callTool({
      name: "act_on_build_computer",
      arguments: { computer_id: id, action, ...fields },
    });
  const results: unknown[] = [];

  const typed = await act("type_secret", { secret: "master" });
  results.push(typed);
  expect(typed.isError, JSON.stringify(typed)).not.toBe(true);
  expect(
    toolContract("act_on_build_computer").outputSchema.parse(
      typed.structuredContent,
    ),
  ).toMatchObject({
    action: "type_secret",
    action_index: 0,
    result: { applied: "yes", summary: "Typed the secret master" },
  });
  expect(
    (typed as CallToolResult).content.filter((block) => block.type === "image"),
  ).toEqual([]);
  expect(computer.calls.at(-1)).toEqual({
    name: "computer_type",
    arguments: { text: VALUE },
  });

  const shot = await act("type_secret", { secret: "master", screenshot: true });
  results.push(shot);
  expect(errorMessage(shot)).toContain("screenshot");
  const shared = await act("type_secret", { secret: "shared" });
  results.push(shared);
  expect(errorMessage(shared)).toContain("chmod 600");
  const absent = await act("type_secret", { secret: "absent" });
  results.push(absent);
  expect(errorMessage(absent)).toContain(
    join(config, "rea", "build-secrets", "absent"),
  );

  // The driver's refusal could quote what it was given, so REA shows none of it.
  computer.refuseNext("computer_type", `cannot type ${VALUE} here`);
  const refused = await act("type_secret", { secret: "master" });
  results.push(refused);
  expect(errorMessage(refused)).toContain("master");
  // Any later result quoting a typed value shows its handle instead.
  computer.refuseNext("computer_click", `the field reads ${VALUE}`);
  const quoted = await act("click", { x: 1, y: 2 });
  results.push(quoted);
  expect(errorMessage(quoted)).toContain("the field reads <secret:master>");

  expect(computer.calls.map(({ name }) => name)).toEqual([
    "computer_screenshot",
    "computer_type",
    "computer_type",
    "computer_click",
  ]);
  expect(JSON.stringify(results)).not.toContain(VALUE);
});

const lines = (...text: string[]) => ({
  "Documents/today.txt": {
    format: "text",
    view: { lines: text, line_count: text.length, truncated: false },
    truncated: false,
  },
});

/** A bundle folder holding TASK as the export writes it for the app. */
const taskBundle = async (app: string) => {
  const parsed = parseDesktopTask(TASK, isPortableBundleName);
  if (!parsed.ok) throw new Error(parsed.error);
  const bundle = await bundleFolder();
  const verifier = join(
    bundle,
    "artifacts",
    taskVerifierArtifact(parsed.value),
    "verify.py",
  );
  await mkdir(join(verifier, ".."), { recursive: true });
  await writeFile(verifier, renderTaskVerifier(parsed.value, app));
  await writeFile(
    join(bundle, "tasks", `${parsed.value.name}.json`),
    renderTaskSteps(parsed.value, app),
  );
  return bundle;
};

it("records a typed secret in witness.json by its handle, and no typed value anywhere", async () => {
  const app: FakeApp = {
    name: "notes",
    state: lines("milk"),
    seed: lines("milk"),
    methods: [],
  };
  const { runner } = await buildComputerFakes({ app });
  const config = await secretsConfig({ master: { text: VALUE } });
  const client = await connectBuildServer({
    ...runner.environment,
    XDG_CONFIG_HOME: config,
  });
  const id = await startBuildComputer(client, {
    kind: "bundle",
    path: await taskBundle(app.name),
  });
  const directory = join(await createTestTempDirectory("witness-"), "w");
  const check = (fields: Record<string, unknown>) =>
    callOk(client, "check_build_task", {
      computer_id: id,
      task: TASK,
      ...fields,
    });
  const act = (action: string, fields: Record<string, unknown> = {}) =>
    callOk(client, "act_on_build_computer", {
      computer_id: id,
      action,
      ...fields,
    });

  await check({ stage: "seed", directory });
  await act("type_secret", { secret: "master" });
  app.state = lines("milk", "eggs");
  await check({ stage: "after_edit" });
  // Typed as text, as an agent told the value in chat would type it.
  await act("type", { text: `x ${VALUE}` });
  app.state = lines("milk", "egg");
  await check({ stage: "near_miss" });
  await act("reset");
  const ended = await check({ stage: "after_reset" });
  expect(ended.structuredContent).toMatchObject({
    witness: { record: { verdict: "held" } },
  });
  expect(JSON.stringify(ended)).not.toContain(VALUE);

  const record = await readFile(join(directory, "witness.json"), "utf8");
  expect(record).not.toContain(VALUE);
  const { normalized_result: result } = JSON.parse(record) as {
    normalized_result: { actions: { action: string; arguments: unknown }[] };
  };
  expect(
    result.actions
      .filter(({ action }) => action.startsWith("type"))
      .map(({ arguments: logged }) => logged),
  ).toEqual([{ secret: "master" }, { text: "x <secret:master>" }]);
});

it("refuses to write a bundle that holds a handle's value, naming the files but not the value", async () => {
  // The secret's value is the task's name, which the exported bundle holds.
  const config = await secretsConfig({ "task-name": { text: TASK.name } });
  const { client } = await buildCaptureFakes({
    serverEnv: { XDG_CONFIG_HOME: config },
  });
  const id = await startBuildComputer(client, REQUEST);
  await callOk(client, "start_build_capture", { computer_id: id });
  const mark = (name: string) =>
    callOk(client, "mark_build_checkpoint", { computer_id: id, name });
  await mark("seed");
  await mark("end");
  await callOk(client, "stop_build_capture", { computer_id: id });
  const directory = join(await createTestTempDirectory("build-out-"), "notes");
  const refused = await client.callTool({
    name: "export_build_environment",
    arguments: { computer_id: id, task: TASK, directory },
  });
  const { error } = parseMcpToolError(refused as CallToolResult);
  expect(error.code).toBe("invalid_request");
  expect(error.message).toContain("task-name");
  expect(error.message).toContain("tasks/<secret:task-name>.json");
  expect(error.message).not.toContain(TASK.name);
  expect(await readdir(directory).catch(() => [])).toEqual([]);
});

it("refuses UTF-16 credentials in seeded files and gzip content", async () => {
  const { client, outputs } = await buildCaptureFakes();
  const id = await startBuildComputer(client, REQUEST);
  await callOk(client, "start_build_capture", { computer_id: id });
  for (const name of ["seed", "end"])
    await callOk(client, "mark_build_checkpoint", { computer_id: id, name });
  await callOk(client, "stop_build_capture", { computer_id: id });
  const seed = join(outputs.bundle, "envs/notes/seed/Documents");
  await mkdir(seed, { recursive: true });
  const token =
    "eyJhbGciOiJub25lIn0.eyJzdWIiOiJyZWEtdGVzdCJ9.ZmFrZS1zaWduYXR1cmU";
  const bytes = Buffer.from(`token=${token}\n`, "utf16le").swap16();
  await writeFile(join(seed, "credential.txt"), bytes);
  await writeFile(join(seed, "credential.txt.gz"), gzipSync(bytes));
  const directory = join(await createTestTempDirectory("build-out-"), "notes");
  const refused = await client.callTool({
    name: "export_build_environment",
    arguments: { computer_id: id, task: TASK, directory },
  });
  const { error } = parseMcpToolError(refused as CallToolResult);
  expect(error.code).toBe("invalid_request");
  expect(error.message).toContain("credential.txt");
  expect(error.message).toContain("credential.txt.gz");
  expect(error.message).toContain("jwt");
  expect(JSON.stringify(refused)).not.toContain(token);
  expect(await readdir(directory).catch(() => [])).toEqual([]);
});
