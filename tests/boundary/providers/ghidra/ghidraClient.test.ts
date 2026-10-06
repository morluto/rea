import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import type { Logger } from "../../../../src/logger.js";

import { ok } from "../../../../src/domain/result.js";
import {
  GhidraClient,
  type GhidraDiagnostic,
} from "../../../../src/ghidra/GhidraClient.js";
import type {
  GhidraLaunchSession,
  GhidraLauncher,
} from "../../../../src/ghidra/GhidraLauncher.js";
import type { GhidraTransportKind } from "../../../../src/ghidra/GhidraTransport.js";
import { GHIDRA_SESSION_CAPABILITIES } from "../../../../src/ghidra/GhidraSessionValues.js";

const fixturePath = fileURLToPath(
  new URL("../../../fixtures/fakeGhidra.mjs", import.meta.url),
);
const PROFILE_DIGEST = "a".repeat(64);
const PROVIDER_VERSION = "12.1.4";
const TARGET_SHA256 = createHash("sha256")
  .update(readFileSync(fixturePath))
  .digest("hex");
const HOST_TRANSPORT: GhidraTransportKind =
  process.platform === "win32" ? "authenticated-loopback-tcp" : "unix-socket";

type FixtureMode =
  | "success"
  | "fragmented"
  | "wrong_identity"
  | "malformed"
  | "contradictory"
  | "future_id"
  | "analysis_timeout"
  | "remote_error"
  | "shutdown_error"
  | "invalid_shutdown_ack"
  | "hang_after_start"
  | "hang_tools"
  | "exit_tools"
  | "silent"
  | "exit";

class FixtureLauncher implements GhidraLauncher {
  readonly runtimeRoots: string[] = [];
  readonly endpointPaths: string[] = [];
  readonly tokens: string[] = [];
  readonly processes: ChildProcess[] = [];

  constructor(readonly mode: FixtureMode = "success") {}

  async launch(session: GhidraLaunchSession) {
    this.runtimeRoots.push(session.runtimeRoot);
    this.endpointPaths.push(session.endpointPath);
    this.tokens.push(session.token);
    const projectRoot = join(session.runtimeRoot, "project");
    await mkdir(projectRoot, { recursive: true });
    const process_ = spawn(process.execPath, [fixturePath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        REA_GHIDRA_FIXTURE_CONFIG: JSON.stringify({
          endpointPath: session.endpointPath,
          token: session.token,
          runId: session.runId,
          providerVersion: session.providerVersion,
          profileDigest: session.profileDigest,
          targetSha256: session.targetSha256,
          transport: session.transport,
          mode: this.mode,
        }),
      },
    });
    this.processes.push(process_);
    return ok({
      process: process_,
      ownsProcessLifetime: true,
      projectRoot,
      ghidraLogPath: join(session.runtimeRoot, "ghidra.log"),
      scriptLogPath: join(session.runtimeRoot, "script.log"),
    });
  }
}

const clients: GhidraClient[] = [];
const clientFor = (
  launcher: GhidraLauncher,
  options: {
    readonly startupTimeoutMs?: number;
    readonly onDiagnostic?: (event: GhidraDiagnostic) => void;
    readonly transport?: GhidraTransportKind;
    readonly runId?: string;
    readonly logger?: Logger;
  } = {},
): GhidraClient => {
  const client = new GhidraClient({
    launcher,
    targetPath: fixturePath,
    targetSha256: TARGET_SHA256,
    transport: options.transport ?? HOST_TRANSPORT,
    providerVersion: PROVIDER_VERSION,
    profileDigest: PROFILE_DIGEST,
    startupTimeoutMs: options.startupTimeoutMs ?? 1_000,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.onDiagnostic === undefined
      ? {}
      : { onDiagnostic: options.onDiagnostic }),
  });
  clients.push(client);
  return client;
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("GhidraClient", () => {
  it("completes an exact, fragmented post-analysis handshake", async () => {
    const launcher = new FixtureLauncher("fragmented");
    const client = clientFor(launcher);

    const started = await client.start();
    expect(started).toMatchObject({
      ok: true,
      value: {
        provider: { id: "ghidra", version: PROVIDER_VERSION },
        profile_digest: PROFILE_DIGEST,
        read_only: true,
        analysis_complete: true,
        analysis_timed_out: false,
        capabilities: GHIDRA_SESSION_CAPABILITIES,
        target: {
          image_base: "0x1000",
          default_address_space: "ram",
        },
      },
    });
    if (started.ok) expect(started.value).not.toHaveProperty("bridge_version");
    if (HOST_TRANSPORT === "unix-socket")
      expect(Buffer.byteLength(launcher.endpointPaths[0] ?? "")).toBeLessThan(
        108,
      );
    else expect(launcher.endpointPaths[0]).toMatch(/bridge-endpoint\.json$/u);
  });

  it("completes the same authenticated handshake over loopback TCP", async () => {
    const launcher = new FixtureLauncher();
    const client = clientFor(launcher, {
      transport: "authenticated-loopback-tcp",
    });

    await expect(client.start()).resolves.toMatchObject({
      ok: true,
      value: {
        target: { sha256: TARGET_SHA256 },
      },
    });
    expect(launcher.endpointPaths[0]).toMatch(/bridge-endpoint\.json$/u);
  });

  it("correlates an admitted inventory request after startup", async () => {
    const client = clientFor(new FixtureLauncher());

    await expect(
      client.callTool("list_procedures", {
        document: null,
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: [
        {
          address: "0x1000",
          value: "fixture_main",
          procedure: { external: false, thunk: false },
        },
      ],
    });
  });

  it("preserves an authenticated operation failure code and diagnostics", async () => {
    const client = clientFor(new FixtureLauncher("remote_error"));

    const result = await client.callTool("list_procedures", {
      document: null,
      offset: 0,
      limit: 500,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "remote",
        remoteCode: "not_found",
        diagnostics: {
          remote_code: "not_found",
          remote_message: "Unknown Ghidra procedure name",
        },
      },
    });
  });

  it.each([
    ["wrong_identity", "protocol"],
    ["malformed", "protocol"],
    ["contradictory", "protocol"],
    ["future_id", "protocol"],
    ["analysis_timeout", "analysis_timeout"],
    ["exit", "process"],
  ] as const)("projects %s startup as %s", async (mode, expectedKind) => {
    const client = clientFor(new FixtureLauncher(mode));
    const result = await client.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe(expectedKind);
  });
});

describe("GhidraClient startup lifecycle", () => {
  it("applies one startup deadline and removes the private runtime", async () => {
    const launcher = new FixtureLauncher("silent");
    const client = clientFor(launcher, { startupTimeoutMs: 30 });

    const result = await client.start();

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "timeout", timeoutMs: 30 },
    });
    await expect(access(launcher.runtimeRoots[0] ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await client.close();
    await expect(waitForExit(launcher.processes[0])).resolves.toBe(true);
  });

  it("cancels startup promptly and leaves no project or process", async () => {
    const launcher = new FixtureLauncher("silent");
    const client = clientFor(launcher, { startupTimeoutMs: 10_000 });
    const controller = new AbortController();
    const pending = client.start(controller.signal);
    setTimeout(() => controller.abort(), 10);

    const result = await pending;

    expect(result).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    await expect(access(launcher.runtimeRoots[0] ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await client.close();
    const process_ = launcher.processes[0];
    if (process_ !== undefined)
      await expect(waitForExit(process_)).resolves.toBe(true);
  });
});

describe("GhidraClient established requests", () => {
  it("fails an established function request when the provider process exits", async () => {
    const client = clientFor(new FixtureLauncher("exit_tools"));
    await expect(client.start()).resolves.toMatchObject({ ok: true });

    await expect(
      client.callTool("procedure_pseudo_code", {
        document: null,
        procedure: "fixture_main",
      }),
    ).resolves.toMatchObject({ ok: false, error: { kind: "process" } });
  });

  it("cancels queued work and stops active provider work on cancellation", async () => {
    const launcher = new FixtureLauncher("hang_tools");
    const client = clientFor(launcher);
    await expect(client.start()).resolves.toMatchObject({ ok: true });
    const activeController = new AbortController();
    const active = client.callTool(
      "procedure_pseudo_code",
      { document: null, procedure: "fixture_main" },
      { signal: activeController.signal },
    );
    await wait(5);
    const queuedController = new AbortController();
    const queued = client.callTool(
      "procedure_info",
      { document: null, procedure: "fixture_main" },
      { signal: queuedController.signal },
    );
    queuedController.abort();

    await expect(queued).resolves.toMatchObject({
      ok: false,
      error: { kind: "cancelled" },
    });
    const waiting = client.callTool("procedure_info", {
      document: null,
      procedure: "fixture_main",
    });
    await wait(5);
    const process_ = launcher.processes[0];
    activeController.abort();
    await expect(active).resolves.toMatchObject({
      ok: false,
      error: { kind: "cancelled" },
    });
    expect(await waitForExit(process_)).toBe(true);
    await expect(waiting).resolves.toMatchObject({
      ok: false,
      error: { kind: "process" },
    });
  });
});

describe("GhidraClient cleanup and diagnostics", () => {
  it("makes double close idempotent and releases its process runtime", async () => {
    const launcher = new FixtureLauncher();
    const client = clientFor(launcher);
    await expect(client.start()).resolves.toMatchObject({ ok: true });

    await Promise.all([client.close(), client.close()]);
    await client.close();

    await expect(access(launcher.runtimeRoots[0] ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const process_ = launcher.processes[0];
    expect(exited(process_)).toBe(true);
    if (process_ === undefined)
      throw new Error("Fixture process was not captured");
  });

  it("retains actionable runtime coordinates after successful cleanup", async () => {
    const launcher = new FixtureLauncher();
    const client = clientFor(launcher, {
      runId: "11111111-1111-4111-8111-111111111111",
    });
    await expect(client.start()).resolves.toMatchObject({ ok: true });

    await client.close();

    expect(client.diagnostics()).toMatchObject({
      runtime_root: launcher.runtimeRoots[0],
      transport: HOST_TRANSPORT,
      endpoint_path: launcher.endpointPaths[0],
      project_root: join(launcher.runtimeRoots[0] ?? "", "project"),
      process_id: expect.any(Number),
      run_id: "11111111-1111-4111-8111-111111111111",
    });
    await expect(access(launcher.runtimeRoots[0] ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("retains actionable diagnostics without retaining its token", async () => {
    const launcher = new FixtureLauncher("exit");
    const events: GhidraDiagnostic[] = [];
    const client = clientFor(launcher, {
      onDiagnostic: (event) => events.push(event),
    });
    const result = await client.start();
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const encoded = JSON.stringify(result.error.diagnostics);
    expect(result.error.diagnostics.target_path).toBe(fixturePath);
    expect(encoded).toContain(PROFILE_DIGEST);
    expect(encoded).not.toContain(launcher.tokens[0] ?? "missing-token");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "launcher-exit" }),
    );
  });
});

const exited = (process_: ChildProcess | undefined): boolean =>
  process_ !== undefined &&
  (process_.exitCode !== null || process_.signalCode !== null);

const waitForExit = async (
  process_: ChildProcess | undefined,
): Promise<boolean> => {
  for (let attempt = 0; attempt < 1_000 && !exited(process_); attempt += 1) {
    await wait(10);
  }
  return exited(process_);
};

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

describe("GhidraClient rejected requests", () => {
  it("redacts authentication after failed startup cleanup and retry", async () => {
    const fixture = new FixtureLauncher();
    const tokens: string[] = [];
    const launcher: GhidraLauncher = {
      launch: async (session) => {
        tokens.push(session.token);
        if (tokens.length === 1)
          throw new Error("Launch rejected before process creation");
        return fixture.launch(session);
      },
    };
    let rejectCompletion = false;
    const logger = pino(
      {
        level: "debug",
        hooks: {
          logMethod(args, method) {
            const fields = args[0];
            if (
              rejectCompletion &&
              typeof fields === "object" &&
              fields !== null &&
              "method" in fields &&
              fields.method === "list_procedures"
            )
              throw new Error(
                `Late failure ${tokens.join(" ")} /tmp/public-fixture`,
              );
            method.apply(this, args);
          },
        },
      },
      { write: () => undefined },
    );
    const client = clientFor(launcher, { logger });
    await expect(client.start()).resolves.toMatchObject({
      ok: false,
      error: { kind: "start" },
    });
    await expect(client.start()).resolves.toMatchObject({ ok: true });
    expect(tokens).toHaveLength(2);
    rejectCompletion = true;
    const result = await client.callTool("list_procedures", { document: null });
    expect(result).toMatchObject({
      ok: false,
      error: {
        diagnostics: {
          failure_cause: {
            message: "Late failure [REDACTED] [REDACTED] /tmp/public-fixture",
          },
        },
      },
    });
    if (result.ok) throw new Error("Expected late failure");
    for (const token of tokens)
      expect(JSON.stringify(result.error.diagnostics)).not.toContain(token);
  });

  it("retains an unexpected wire rejection and continues serial requests", async () => {
    const launcher = new FixtureLauncher();
    const cause = Object.assign(new TypeError("Request completion rejected"), {
      code: "ECOMPLETION",
    });
    let rejectCompletion = true;
    const logger = pino(
      {
        level: "debug",
        hooks: {
          logMethod(args, method) {
            const fields = args[0];
            if (
              rejectCompletion &&
              typeof fields === "object" &&
              fields !== null &&
              "method" in fields &&
              fields.method === "list_procedures"
            ) {
              rejectCompletion = false;
              throw cause;
            }
            method.apply(this, args);
          },
        },
      },
      { write: () => undefined },
    );
    const client = clientFor(launcher, { logger });
    const first = client.callTool("list_procedures", { document: null });
    const second = client.callTool("list_procedures", { document: null });
    const result = await first;
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "protocol",
        diagnostics: {
          failure_cause: {
            name: "TypeError",
            message: cause.message,
            code: "ECOMPLETION",
          },
        },
      },
    });
    if (result.ok) throw new Error("Expected rejected request");
    expect(result.error.cause).toBe(cause);
    await expect(second).resolves.toMatchObject({ ok: true });
  });
});

describe("GhidraClient shutdown diagnostics", () => {
  it("logs an unexpected shutdown rejection and still removes its process and runtime", async () => {
    const launcher = new FixtureLauncher();
    const logs: string[] = [];
    const logger = pino(
      {
        level: "debug",
        hooks: {
          logMethod(args, method) {
            const fields = args[0];
            if (
              typeof fields === "object" &&
              fields !== null &&
              "method" in fields &&
              fields.method === "shutdown"
            )
              throw Object.assign(
                new Error(
                  `Shutdown rejected ${launcher.tokens[0]} /tmp/password-fixture`,
                ),
                { code: "ESHUTDOWN" },
              );
            method.apply(this, args);
          },
        },
      },
      {
        write: (line) => {
          logs.push(line);
        },
      },
    );
    const client = clientFor(launcher, { logger });
    await expect(client.start()).resolves.toMatchObject({ ok: true });
    await expect(client.close()).resolves.toBeUndefined();
    const warning: unknown[] = logs.map((line) => JSON.parse(line));
    expect(warning).toContainEqual(
      expect.objectContaining({
        status: "failed",
        kind: "process",
        message: "Ghidra shutdown request failed",
        diagnostics: expect.objectContaining({
          failure_cause: {
            name: "Error",
            message: "Shutdown rejected [REDACTED] /tmp/password-fixture",
            code: "ESHUTDOWN",
          },
        }),
      }),
    );
    expect(logs.join("")).not.toContain(launcher.tokens[0]);
    await expect(access(launcher.runtimeRoots[0] ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(waitForExit(launcher.processes[0])).resolves.toBe(true);
  });

  it.each(["shutdown_error", "invalid_shutdown_ack"] as const)(
    "keeps cleanup best effort for %s",
    async (mode) => {
      const launcher = new FixtureLauncher(mode);
      const logs: string[] = [];
      const logger = pino(
        { level: "warn" },
        {
          write: (line) => {
            logs.push(line);
          },
        },
      );
      const client = clientFor(launcher, { logger });
      await expect(client.start()).resolves.toMatchObject({ ok: true });
      await expect(client.close()).resolves.toBeUndefined();
      const warning: unknown[] = logs.map((line) => JSON.parse(line));
      expect(warning).toContainEqual(
        expect.objectContaining({
          msg: "Ghidra bridge shutdown was not confirmed",
          status:
            mode === "shutdown_error" ? "failed" : "invalid-acknowledgement",
        }),
      );
      if (mode === "shutdown_error") {
        expect(warning).toContainEqual(
          expect.objectContaining({
            kind: "remote",
            diagnostics: expect.objectContaining({
              remote_code: "shutdown_fixture_failure",
              remote_message:
                "Shutdown denied for [REDACTED]: /tmp/password-fixture http://localhost/secret?token=public-value",
            }),
          }),
        );
      }
      expect(logs.join("")).not.toContain(launcher.tokens[0]);
      await expect(
        access(launcher.runtimeRoots[0] ?? ""),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(waitForExit(launcher.processes[0])).resolves.toBe(true);
    },
  );
});
