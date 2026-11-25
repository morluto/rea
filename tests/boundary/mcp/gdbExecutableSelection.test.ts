import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { closeVerifierResources } from "../../../scripts/lib/verifier-cleanup.mjs";
import { evidenceSchema } from "../../../src/domain/evidence.js";
import { advertisedInputDialectViolations } from "../../../src/contracts/advertisedDialect.js";
import { createCliShell } from "../../../src/cli/cliShell.js";
import { plain } from "../../../src/cli/cliCommandRegistration.js";
import { registerReverseEngineeringCommands } from "../../../src/cli/reverseEngineeringCommands.js";
import { serveInProcessCli } from "../../support/cli/serveInProcessCli.js";
import { phaseGate } from "../../support/lifecycleHarness.js";
import { GdbSessionManager } from "../../../src/gdb/GdbSessionManager.js";
import { stopOwnedDebuggerProcess } from "../../../src/process/ownedDebuggerSession.js";
import { gdbMcpServer } from "../../fixtures/debuggerMcp.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { waitForStartedFile } from "../../support/reverseDebuggerMcpTestHelpers.js";
import {
  createGdbFixtureOwner,
  expectNoUnmodeledGdbCommands,
  FAKE_GDB_SESSION_REPLIES,
  fakeGdbModeledReplies,
  fakeGdbStartupPreamble,
} from "../providers/gdbTestHelpers.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { COMPLETE_DETAIL } from "../../support/completeDetail.js";

const selectedBytes = Buffer.from("caller-selected executable bytes\n");
const selectedDigest = createHash("sha256").update(selectedBytes).digest("hex");
const startSchema = z.object({ session_id: z.string().uuid() });

it.skipIf(process.platform === "win32")(
  "loads the selected file through the public one-shot CLI",
  async () => {
    const f = await fixture("load");
    const registration = plain(
      async () => registerReverseEngineeringCommands,
      (register, context) =>
        register(
          context.cli,
          context.logger,
          context.environment,
          () => f.manager,
        ),
    );
    const cli = createCliShell({
      selectedEnvironment: { CI: "1" },
      registrations: [
        { registration, module: registerReverseEngineeringCommands },
      ],
    });
    const reply = await serveInProcessCli(cli, [
      "debug-with-gdb",
      ...COMPLETE_DETAIL,
      "info files",
      "--executable",
      f.executable,
      "--inferior-tty",
      f.tty,
      "--json",
    ]);
    expect(reply.exitCode).toBe(0);
    const evidence = evidenceSchema.parse(JSON.parse(reply.stdout));
    expect(evidence.subject.identity).toMatchObject({
      kind: "session",
      target: { kind: "file", sha256: selectedDigest },
    });
    expect(evidence.parameters.launch_provenance).toMatchObject({
      caller_selected_path: f.executable,
    });
    expect(await f.requests()).toContain(f.load);
  },
);

it.skipIf(process.platform === "win32")(
  "does not retry a refused executable load after confirmed cleanup",
  async () => {
    const f = await fixture("refuse");
    const reply = await f.client.callTool({
      name: "start_gdb_session",
      arguments: { executable: f.executable },
    });
    expect(parseMcpToolError(reply).error.code).toBe("capability_unavailable");
    expect(
      (await f.requests()).filter((command) => command === f.load),
    ).toHaveLength(1);
  },
);

it.skipIf(process.platform === "win32")(
  "ignores late load completion when caller cancellation overlaps manager-close cleanup",
  async () => {
    const cleanup = phaseGate();
    const f = await fixture("wait", {
      stopProcess: async (session, name) => {
        await cleanup.hold();
        return stopOwnedDebuggerProcess(session, name);
      },
    });
    const caller = new AbortController();
    const lateReason = { reason: "late caller cancellation" };
    const starting = f.manager.start(caller.signal, {
      executable: f.executable,
    });
    let closing: Promise<void> | undefined;
    try {
      await waitForStartedFile(f.arrived);
      closing = f.manager.closeAll();
      await cleanup.reached(starting, "GDB load cleanup");
      caller.abort(lateReason);
      await writeFile(f.release, "release");
      await waitForStartedFile(f.lateAck);
      cleanup.release();
      const result = await starting;
      expect(result.ok).toBe(false);
      if (result.ok)
        throw new Error("Late load completion published a session");
      expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(result.error.cause).not.toBe(lateReason);
      expect(result.error.partialObservation).toMatchObject({
        operation: "start_gdb_session",
      });
      await closing;
    } finally {
      cleanup.release();
      await starting;
      await closing;
    }
  },
);

/** The fake acknowledges only modeled MI operations, and never runs an inferior. */
const fixture = async (
  mode: "load" | "refuse" | "wait",
  options: Pick<
    NonNullable<ConstructorParameters<typeof GdbSessionManager>[0]>,
    "stopProcess"
  > = {},
) => {
  const root = await createTestTempDirectory("rea-gdb-selected-file-");
  const owner = createGdbFixtureOwner();
  const managers: GdbSessionManager[] = [];
  const connections: Array<() => void | Promise<void>> = [];
  const unmodeled = join(root, "unmodeled");
  onTestFinished(() =>
    closeVerifierResources([
      ...connections,
      () =>
        owner.cleanup(managers, async () => {
          await expectNoUnmodeledGdbCommands(unmodeled);
        }),
    ]),
  );
  const executable = join(root, 'selected "file".bin');
  await writeFile(executable, selectedBytes);
  const requests = join(root, "requests.jsonl");
  const arrived = join(root, "load.arrived");
  const release = join(root, "load.release");
  const lateAck = join(root, "load.replied");
  const tty = join(root, "inferior-tty");
  const provider = join(root, "fake-gdb.mjs");
  const load = `-file-exec-and-symbols ${JSON.stringify(executable)}`;
  await writeFile(
    provider,
    `#!${process.execPath}
${fakeGdbStartupPreamble}
${fakeGdbModeledReplies(unmodeled, {
  ...FAKE_GDB_SESSION_REPLIES,
  [`-inferior-tty-set ${JSON.stringify(tty)}`]: "^done",
  "-inferior-tty-show": `^done,inferior_tty_terminal=${JSON.stringify(tty)}`,
  '-interpreter-exec console "info files"': "^done",
  '-interpreter-exec console "file /other/file"': "^done",
})}
const fs = process.getBuiltinModule("node:fs");
process.stdout.write("(gdb)\\n");
let input = "";
process.stdin.on("data", chunk => {
  input += chunk;
  for (;;) {
    const end = input.indexOf("\\n");
    if (end < 0) break;
    const line = input.slice(0, end); input = input.slice(end + 1);
    const parsed = /^(\\d+)(.*)$/.exec(line);
    if (!parsed) continue;
    const [, token, command] = parsed;
    fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(command) + "\\n");
    if (command === ${JSON.stringify(load)}) {
      if (${JSON.stringify(mode)} === "wait") {
        const watcher = fs.watch(${JSON.stringify(root)}, () => {
          if (!fs.existsSync(${JSON.stringify(release)})) return;
          watcher.close();
          process.stdout.write(token + "^done\\n");
          fs.writeFileSync(${JSON.stringify(lateAck)}, "started");
        });
      }
      fs.writeFileSync(${JSON.stringify(arrived)}, "started");
      if (${JSON.stringify(mode)} !== "wait")
        process.stdout.write(token + (${JSON.stringify(mode)} === "refuse" ? '^error,msg="load refused"' : "^done") + "\\n");
    } else answerModeled(token, command);
  }
});
`,
  );
  await chmod(provider, 0o700);
  const manager = new GdbSessionManager({
    platform: "linux",
    environment: { REA_GDB_COMMAND: provider },
    spawnProcess: owner.spawnProcess,
    ...options,
  });
  managers.push(manager);
  const server = gdbMcpServer("gdb-executable-selection", manager);
  const validation = createMcpSchemaValidation();
  const client = new Client(
    { name: "gdb-executable-selection", version: "1" },
    { jsonSchemaValidator: validation },
  );
  connections.push(
    () => client.close(),
    () => server.close(),
    async () => validation.clear(),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    manager,
    executable,
    load,
    arrived,
    release,
    lateAck,
    tty,
    requests: async (): Promise<string[]> =>
      (await readFile(requests, "utf8"))
        .trim()
        .split("\n")
        .map((line) => z.string().parse(JSON.parse(line))),
  };
};

it.skipIf(process.platform === "win32")(
  "binds MCP command Evidence to the selected initial file without running or rebinding it",
  async () => {
    const f = await fixture("load");
    const listed = (await f.client.listTools()).tools.find(
      ({ name }) => name === "start_gdb_session",
    );
    expect(listed?.inputSchema.properties).toHaveProperty("executable");
    if (listed === undefined)
      throw new Error("GDB startup contract is missing");
    expect(advertisedInputDialectViolations(listed)).toEqual([]);
    const validate = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(listed.inputSchema);
    expect(validate({})).toBe(true);
    expect(validate({ executable: f.executable })).toBe(true);
    expect(validate({ executable: 42 })).toBe(false);
    expect(validate({ executable: f.executable, unexpected: true })).toBe(
      false,
    );
    // Advertised patterns may widen; canonical admission must still refuse
    // a relative path before any debugger operation is sent.
    const invalid = await f.client.callTool({
      name: "start_gdb_session",
      arguments: { executable: "relative-file" },
    });
    expect(invalid.isError).toBe(true);
    await expect(f.requests()).rejects.toMatchObject({ code: "ENOENT" });
    const started = await f.client.callTool({
      name: "start_gdb_session",
      arguments: { executable: f.executable },
    });
    expect(started.isError).not.toBe(true);
    const { session_id } = startSchema.parse(started.structuredContent);
    const before = await f.requests();
    expect(before).toEqual(["-gdb-set auto-load off", f.load]);
    for (const command of ["info files", "file /other/file", "info files"]) {
      const reply = await f.client.callTool({
        name: "gdb_console",
        arguments: { detail: "complete", session_id, command },
      });
      expect(reply.isError).not.toBe(true);
      const evidence = evidenceSchema.parse(reply.structuredContent);
      expect(evidence.subject.identity).toEqual({
        kind: "session",
        session_kind: "gdb",
        id: session_id,
        target: {
          kind: "file",
          sha256: selectedDigest,
          format: "file",
          architecture: null,
          selection: null,
        },
      });
      expect(evidence.parameters).toMatchObject({
        launch_provenance: {
          caller_selected_path: f.executable,
          resolved_path: f.executable,
        },
      });
    }
  },
);

it.skipIf(process.platform === "win32")(
  "keeps an omitted GDB executable unknown",
  async () => {
    const f = await fixture("load");
    const started = await f.client.callTool({
      name: "start_gdb_session",
      arguments: {},
    });
    const { session_id } = startSchema.parse(started.structuredContent);
    const reply = await f.client.callTool({
      name: "gdb_console",
      arguments: { detail: "complete", session_id, command: "info files" },
    });
    const evidence = evidenceSchema.parse(reply.structuredContent);
    expect(evidence.subject.identity).toMatchObject({
      target: { kind: "unknown", reason: "not-observed" },
    });
    expect(evidence.parameters).not.toHaveProperty("launch_provenance");
    expect(await f.requests()).not.toContain(f.load);
  },
);

it.skipIf(process.platform === "win32")(
  "retains failed startup cleanup after a refused load for retry",
  async () => {
    let stops = 0;
    const f = await fixture("refuse", {
      stopProcess: async (session, name) =>
        ++stops === 1
          ? {
              status: "incomplete",
              code: "stop-failed",
              reason: "injected load cleanup uncertainty",
            }
          : stopOwnedDebuggerProcess(session, name),
    });
    const reply = await f.client.callTool({
      name: "start_gdb_session",
      arguments: { executable: f.executable },
    });
    const failure = parseMcpToolError(reply);
    expect(failure.error).toMatchObject({ code: "cleanup_incomplete" });
    const details = z
      .object({ resources: z.tuple([z.string().uuid()]) })
      .parse(failure.error.details);
    expect(f.manager.status(details.resources[0])?.state).toBe("closed");
    expect(
      (await f.requests()).filter((command) => command === f.load),
    ).toHaveLength(1);
    const retry = await f.manager.retryCleanupFailures();
    expect(retry.ok).toBe(true);
    expect(f.manager.status(details.resources[0])).toBeUndefined();
    expect(stops).toBe(2);
  },
);

it.skipIf(process.platform === "win32")(
  "cancels during executable loading before publishing readiness",
  async () => {
    const f = await fixture("wait");
    const controller = new AbortController();
    const starting = f.manager.start(controller.signal, {
      executable: f.executable,
    });
    await waitForStartedFile(f.arrived);
    controller.abort("cancel-selected-load");
    const result = await starting;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Cancelled load published a session");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(
      (await f.requests()).filter((command) => command === f.load),
    ).toHaveLength(1);
    await f.manager.closeAll();
  },
);
