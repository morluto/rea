import {
  chmod,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import type { CallToolResult } from "@modelcontextprotocol/server";
import { expect, it, vi } from "vitest";

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
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import { AgentEnvComputer } from "../../../src/desktop/AgentEnvComputer.js";
import { DesktopBuildSecrets } from "../../../src/application/desktop/DesktopBuildSecrets.js";

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
    arguments: { computer_id: id, tasks: [{ task: TASK }], directory },
  });
  const { error } = parseMcpToolError(refused as CallToolResult);
  expect(error.code).toBe("invalid_request");
  expect(error.message).toContain("task-name");
  expect(error.message).toContain("tasks/<secret:task-name>.json");
  expect(error.message).not.toContain(TASK.name);
  expect(await readdir(directory).catch(() => [])).toEqual([]);
});

it("refuses export if a declared handle cannot be checked", async () => {
  const config = await secretsConfig({ master: { text: VALUE } });
  await symlink("missing", join(config, "rea", "build-secrets", "unreadable"));
  const { client } = await buildCaptureFakes({
    serverEnv: { XDG_CONFIG_HOME: config },
  });
  const id = await startBuildComputer(client, REQUEST);
  await callOk(client, "start_build_capture", { computer_id: id });
  for (const name of ["seed", "end"])
    await callOk(client, "mark_build_checkpoint", { computer_id: id, name });
  await callOk(client, "stop_build_capture", { computer_id: id });
  const directory = join(await createTestTempDirectory("build-out-"), "notes");
  const result = await client.callTool({
    name: "export_build_environment",
    arguments: { computer_id: id, tasks: [{ task: TASK }], directory },
  });
  const { error } = parseMcpToolError(result);
  expect(error.code).toBe("invalid_request");
  expect(error.message).toContain("unreadable");
  expect(error.message).not.toContain(VALUE);
  expect(await readdir(directory).catch(() => [])).toEqual([]);
});

it("refuses a bundle containing a declared form-encoded secret", async () => {
  const value = "e-Fake!Password~42 a";
  const encoded = new URLSearchParams([["q", value]]).toString().slice(2);
  const config = await secretsConfig({ master: { text: value } });
  const { client, outputs, computer } = await buildCaptureFakes({
    serverEnv: { XDG_CONFIG_HOME: config },
  });
  const id = await startBuildComputer(client, REQUEST);
  await callOk(client, "act_on_build_computer", {
    computer_id: id,
    action: "type_secret",
    secret: "master",
  });
  await callOk(client, "start_build_capture", { computer_id: id });
  for (const name of ["seed", "end"])
    await callOk(client, "mark_build_checkpoint", { computer_id: id, name });
  await callOk(client, "stop_build_capture", { computer_id: id });
  const seed = join(outputs.bundle, "envs/notes/seed/Documents");
  await mkdir(seed, { recursive: true });
  await writeFile(join(seed, "settings.txt"), `field=${encoded}`);
  const directory = join(await createTestTempDirectory("build-out-"), "notes");
  const result = await client.callTool({
    name: "export_build_environment",
    arguments: { computer_id: id, tasks: [{ task: TASK }], directory },
  });
  const { error } = parseMcpToolError(result as CallToolResult);
  expect(error.message).toContain("master");
  expect(error.message).not.toContain(encoded);
  expect(await readdir(directory).catch(() => [])).toEqual([]);
  computer.refuseNext("computer_click", `field=${encoded}`);
  const quote = await client.callTool({
    name: "act_on_build_computer",
    arguments: { computer_id: id, action: "click", x: 1, y: 2 },
  });
  expect(errorMessage(quote)).toContain("field=<secret:master>");
});

it.each(["utf8", "utf16le", "utf16be"] as const)(
  "refuses a declared Unicode secret escaped in %s JSON",
  async (encoding) => {
    const value = "e-Clé-Ünïcode-Fake-9";
    const config = await secretsConfig({ master: { text: value } });
    const { client, outputs } = await buildCaptureFakes({
      serverEnv: { XDG_CONFIG_HOME: config },
    });
    const id = await startBuildComputer(client, REQUEST);
    await callOk(client, "start_build_capture", { computer_id: id });
    for (const name of ["seed", "end"])
      await callOk(client, "mark_build_checkpoint", { computer_id: id, name });
    await callOk(client, "stop_build_capture", { computer_id: id });
    const seed = join(outputs.bundle, "envs/notes/seed/Documents");
    await mkdir(seed, { recursive: true });
    const encoded = "e-Cl\\u00e9-\\u00dcn\\u00efcode-Fake-9";
    const json = `{"password":"${encoded}"}`;
    const bytes =
      encoding === "utf8" ? Buffer.from(json) : Buffer.from(json, "utf16le");
    if (encoding === "utf16be") bytes.swap16();
    await writeFile(join(seed, "profile.json"), bytes);
    const directory = join(
      await createTestTempDirectory("build-out-"),
      "notes",
    );
    const result = await client.callTool({
      name: "export_build_environment",
      arguments: { computer_id: id, tasks: [{ task: TASK }], directory },
    });
    const error = parseMcpToolError(result).error;
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("master");
    expect(JSON.stringify(error)).not.toContain(value);
    expect(JSON.stringify(error)).not.toContain(encoded);
    expect(await readdir(directory).catch(() => [])).toEqual([]);
  },
);

it("preserves unmarked token-shaped data in seeded UTF-16 and gzip files", async () => {
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
    arguments: { computer_id: id, tasks: [{ task: TASK }], directory },
  });
  expect(refused.isError, JSON.stringify(refused)).not.toBe(true);
  const plain = await readFile(
    join(directory, "envs/notes/seed/Documents/credential.txt"),
  );
  const compressed = await readFile(
    join(directory, "envs/notes/seed/Documents/credential.txt.gz"),
  );
  expect(plain.equals(bytes)).toBe(true);
  expect(compressed.equals(gzipSync(bytes))).toBe(true);
});

it("refuses a gzip file that expands past what REA checks for known secrets", async () => {
  const config = await secretsConfig({ master: { text: VALUE } });
  const { client, outputs } = await buildCaptureFakes({
    serverEnv: { XDG_CONFIG_HOME: config },
  });
  const id = await startBuildComputer(client, REQUEST);
  await callOk(client, "start_build_capture", { computer_id: id });
  for (const name of ["seed", "end"])
    await callOk(client, "mark_build_checkpoint", { computer_id: id, name });
  await callOk(client, "stop_build_capture", { computer_id: id });
  const seed = join(outputs.bundle, "envs/notes/seed/Documents");
  await mkdir(seed, { recursive: true });
  // An unsigned JWT, built from its parts so secret scanners do not flag the file.
  const token = [
    JSON.stringify({ alg: "none" }),
    JSON.stringify({ sub: "rea-test" }),
    "fake-signature",
  ]
    .map((part) => Buffer.from(part).toString("base64url"))
    .join(".");
  const inside = Buffer.concat([
    Buffer.from(`token=${token}\n`),
    Buffer.alloc(65 * 1024 * 1024),
  ]);
  await writeFile(join(seed, "large.txt.gz"), gzipSync(inside));
  const directory = join(await createTestTempDirectory("build-out-"), "notes");
  const refused = await client.callTool({
    name: "export_build_environment",
    arguments: { computer_id: id, tasks: [{ task: TASK }], directory },
  });
  const { error } = parseMcpToolError(refused as CallToolResult);
  expect(error.code).toBe("invalid_request");
  expect(error.message).toContain("large.txt.gz");
  expect(error.message).toContain("64 MiB");
  expect(await readdir(directory).catch(() => [])).toEqual([]);
});

it("withholds the automatic draft before running it after a declared secret", async () => {
  const config = await secretsConfig({ master: { text: VALUE } });
  const { client, rea } = await buildCaptureFakes({
    serverEnv: { XDG_CONFIG_HOME: config },
  });
  const id = await startBuildComputer(client, REQUEST);
  await callOk(client, "start_build_capture", { computer_id: id });
  await callOk(client, "mark_build_checkpoint", {
    computer_id: id,
    name: "seed",
  });
  await callOk(client, "act_on_build_computer", {
    computer_id: id,
    action: "type_secret",
    secret: "master",
  });
  await callOk(client, "mark_build_checkpoint", {
    computer_id: id,
    name: "end",
  });
  const first = await callOk(client, "stop_build_capture", { computer_id: id });
  const repeated = await callOk(client, "stop_build_capture", {
    computer_id: id,
  });
  expect(first.structuredContent).toMatchObject({
    draft: null,
    draft_refusal: expect.stringContaining("write the task manually"),
  });
  expect(repeated.structuredContent).toEqual(first.structuredContent);
  const calls = (await rea.notes("calls.jsonl")) as { argv: string[] }[];
  expect(
    calls.some(({ argv }) =>
      argv.includes("describe-desktop-application-task"),
    ),
  ).toBe(false);
  expect(JSON.stringify(first)).not.toContain(VALUE);
  const directory = join(
    await createTestTempDirectory("manual-task-"),
    "notes",
  );
  const exported = await client.callTool({
    name: "export_build_environment",
    arguments: { computer_id: id, tasks: [{ task: TASK }], directory },
  });
  expect(exported.isError, JSON.stringify(exported)).not.toBe(true);
});

it("withholds a cached draft after the server later uses a secret", async () => {
  const config = await secretsConfig({ master: { text: VALUE } });
  const { client } = await buildCaptureFakes({
    serverEnv: { XDG_CONFIG_HOME: config },
  });
  const id = await startBuildComputer(client, REQUEST);
  await callOk(client, "start_build_capture", { computer_id: id });
  await callOk(client, "mark_build_checkpoint", {
    computer_id: id,
    name: "seed",
  });
  await callOk(client, "mark_build_checkpoint", {
    computer_id: id,
    name: "end",
  });
  const before = await callOk(client, "stop_build_capture", {
    computer_id: id,
  });
  expect(before.structuredContent).toMatchObject({ draft: expect.any(Object) });
  await callOk(client, "act_on_build_computer", {
    computer_id: id,
    action: "type_secret",
    secret: "master",
  });
  const after = await callOk(client, "stop_build_capture", { computer_id: id });
  expect(after.structuredContent).toMatchObject({
    draft: null,
    draft_refusal: expect.stringContaining("write the task manually"),
  });
});

it.each([
  "capture-output",
  "draft-command",
  "draft-output",
  "draft-failure",
] as const)("rechecks shared secret state during %s", async (phase) => {
  const config = await secretsConfig({ master: { text: VALUE } });
  const { client, rea } = await buildCaptureFakes({
    serverEnv: { XDG_CONFIG_HOME: config },
  });
  const first = await startBuildComputer(client, REQUEST);
  let secrets: DesktopBuildSecrets | undefined;
  const resolve = DesktopBuildSecrets.prototype.resolve;
  const secretSpy = vi
    .spyOn(DesktopBuildSecrets.prototype, "resolve")
    .mockImplementation(function (this: DesktopBuildSecrets, ...args) {
      secrets = this;
      return resolve.apply(this, args);
    });
  const absent = await client.callTool({
    name: "act_on_build_computer",
    arguments: {
      computer_id: first,
      action: "type_secret",
      secret: "absent",
    },
  });
  expect(absent.isError).toBe(true);
  if (secrets === undefined) throw new Error("secret owner was not reached");
  await callOk(client, "start_build_capture", { computer_id: first });
  await callOk(client, "mark_build_checkpoint", {
    computer_id: first,
    name: "seed",
  });
  await callOk(client, "mark_build_checkpoint", {
    computer_id: first,
    name: "end",
  });
  let entered = () => {};
  const acknowledged = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = AgentEnvComputer.prototype.homeFiles;
  const spy = vi
    .spyOn(AgentEnvComputer.prototype, "homeFiles")
    .mockImplementation(async function (
      this: AgentEnvComputer,
      paths,
      bytes,
      signal,
    ) {
      if (
        paths.some((path) =>
          path.endsWith(
            phase === "capture-output"
              ? "/capture.out"
              : phase === "draft-output"
                ? "/draft.json"
                : "/never-match",
          ),
        )
      ) {
        entered();
        await gate;
      }
      return original.call(this, paths, bytes, signal);
    });
  const originalExec = AgentEnvComputer.prototype.exec;
  const execSpy = vi
    .spyOn(AgentEnvComputer.prototype, "exec")
    .mockImplementation(async function (
      this: AgentEnvComputer,
      argv,
      timeout,
      signal,
    ) {
      if (
        (phase === "draft-command" || phase === "draft-failure") &&
        argv.some((arg) => arg.includes("describe-desktop-application-task"))
      ) {
        entered();
        await gate;
        if (phase === "draft-failure") throw new Error(VALUE.slice(0, 10));
      }
      return originalExec.call(this, argv, timeout, signal);
    });
  const stopping = callOk(client, "stop_build_capture", {
    computer_id: first,
  });
  try {
    await awaitAcknowledgement(acknowledged, stopping, "capture output read");
    expect(await secrets.resolve("master")).toEqual({
      ok: true,
      value: VALUE,
    });
    release();
    const stopped = await stopping;
    expect(stopped.structuredContent).toMatchObject({
      draft: null,
      draft_refusal: expect.stringContaining("write the task manually"),
    });
    const calls = (await rea.notes("calls.jsonl")) as { argv: string[] }[];
    expect(
      calls.some(({ argv }) =>
        argv.includes("describe-desktop-application-task"),
      ),
    ).toBe(phase !== "capture-output" && phase !== "draft-failure");
    if (phase === "draft-failure") {
      expect(JSON.stringify(stopped)).not.toContain(VALUE.slice(0, 10));
    }
  } finally {
    release();
    await Promise.allSettled([stopping]);
    spy.mockRestore();
    execSpy.mockRestore();
    secretSpy.mockRestore();
  }
});
