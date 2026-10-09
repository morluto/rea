import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import pino from "pino";
import type { Logger } from "pino";

import { ok } from "../../../../src/domain/result.js";
import { GhidraClient } from "../../../../src/ghidra/GhidraClient.js";
import { GhidraHeadlessLauncher } from "../../../../src/ghidra/GhidraLauncher.js";
import type { GhidraDiagnostic } from "../../../../src/ghidra/GhidraClientTypes.js";
import type {
  GhidraLaunchSession,
  GhidraLauncher,
} from "../../../../src/ghidra/GhidraLauncher.js";
import type { GhidraTransportKind } from "../../../../src/ghidra/GhidraTransport.js";
import { GHIDRA_SESSION_CAPABILITIES } from "../../../../src/ghidra/GhidraSessionValues.js";
import { waitForExit as waitForChildExit } from "../../../support/process/processFixture.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

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
  | "oversized_result"
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
  #notifyStarted: ((child: ChildProcess) => void) | undefined;
  readonly started = new Promise<ChildProcess>((resolve) => {
    this.#notifyStarted = resolve;
  });
  readonly runtimeRoots: string[] = [];
  readonly endpointPaths: string[] = [];
  readonly tokens: string[] = [];
  readonly processes: ChildProcess[] = [];
  readonly requests: string[] = [];

  constructor(readonly mode: FixtureMode = "success") {}

  async launch(session: GhidraLaunchSession) {
    this.runtimeRoots.push(session.runtimeRoot);
    this.endpointPaths.push(session.endpointPath);
    this.tokens.push(session.token);
    const projectRoot = join(session.runtimeRoot, "project");
    await mkdir(projectRoot, { recursive: true });
    const process_ = spawn(process.execPath, [fixturePath], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
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
    process_.on("message", (value: unknown) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "method" in value &&
        typeof value.method === "string"
      )
        this.requests.push(value.method);
    });
    this.processes.push(process_);
    process_.once("spawn", () => this.#notifyStarted?.(process_));
    return ok({
      process: process_,
      ownsProcessLifetime: true as const,
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
  vi.useRealTimers();
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("GhidraClient", () => {
  it("exposes the immutable import snapshot only during the live session", async () => {
    const client = clientFor(new FixtureLauncher());
    await expect(client.readTargetSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { kind: "protocol" },
    });
    await expect(client.start()).resolves.toMatchObject({ ok: true });
    const snapshot = await client.readTargetSnapshot();
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) expect(snapshot.value).toEqual(readFileSync(fixturePath));
    await client.close();
    await expect(client.readTargetSnapshot()).resolves.toMatchObject({
      ok: false,
      error: { kind: "protocol" },
    });
  });

  it("completes an exact, fragmented post-analysis handshake", async () => {
    const launcher = new FixtureLauncher("fragmented");
    const client = clientFor(launcher);

    const started = await client.start();
    expect(started).toMatchObject({
      ok: true,
      value: {
        provider: { id: "ghidra", version: PROVIDER_VERSION },
        profile_digest: PROFILE_DIGEST,
        read_only: HOST_TRANSPORT !== "unix-socket",
        analysis_complete: true,
        analysis_timed_out: false,
        capabilities: GHIDRA_SESSION_CAPABILITIES.filter(
          (value) =>
            HOST_TRANSPORT === "unix-socket" ||
            value !== "annotate_native_function",
        ),
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

    await expect(
      client.callTool("list_strings", { document: null }),
    ).resolves.toMatchObject({
      ok: true,
      value: [{ address: "0x2000", value: "fixture 雪🦊" }],
    });
  });

  it("accepts an owned-socket result above the former 64 MiB ceiling", async () => {
    const client = clientFor(new FixtureLauncher("oversized_result"));
    const result = await client.callTool("list_strings", { document: null });

    if (!result.ok) throw result.error;
    if (!Array.isArray(result.value))
      throw new TypeError("Ghidra fixture result was not an inventory array");
    const first = result.value[0];
    if (typeof first !== "object" || first === null || Array.isArray(first))
      throw new TypeError("Ghidra fixture inventory item was not an object");
    const value = first.value;
    if (typeof value !== "string")
      throw new TypeError("Ghidra fixture string value was missing");
    expect(value.length).toBe(64 * 1024 * 1024 + 1);
    expect(value.slice(0, 4)).toBe("xxxx");
    expect(value.slice(-4)).toBe("xxxx");
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const launcher = new FixtureLauncher("silent");
    const client = clientFor(launcher, { startupTimeoutMs: 30 });

    const pending = client.start();
    const child = await launcher.started;
    await vi.advanceTimersByTimeAsync(30);
    const result = await vi.waitFor(() => pending, { timeout: 10_000 });
    vi.useRealTimers();

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "timeout", timeoutMs: 30 },
    });
    await expect(access(launcher.runtimeRoots[0] ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await client.close();
    await expect(waitForExit(child)).resolves.toBe(true);
  });

  it("cancels startup promptly and leaves no project or process", async () => {
    const launcher = new FixtureLauncher("silent");
    const client = clientFor(launcher, { startupTimeoutMs: 10_000 });
    const controller = new AbortController();
    const pending = client.start(controller.signal);
    const process_ = await launcher.started;
    controller.abort();

    const result = await pending;

    expect(result).toMatchObject({ ok: false, error: { kind: "cancelled" } });
    await expect(access(launcher.runtimeRoots[0] ?? "")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await client.close();
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
    await vi.waitFor(() =>
      expect(launcher.requests).toContain("procedure_pseudo_code"),
    );
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
    expect(launcher.requests).not.toContain("procedure_info");
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

describe("GhidraClient runtime removal failures", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a runtime root it could not remove and removes it on a later close",
    async () => {
      const launcher = new FixtureLauncher();
      const client = clientFor(launcher);
      await expect(client.start()).resolves.toMatchObject({ ok: true });
      const runtimeRoot = launcher.runtimeRoots[0] ?? "";
      // Without write permission its entries cannot be removed.
      await chmod(runtimeRoot, 0o500);
      try {
        await expect(client.close()).resolves.toMatchObject({
          ok: false,
          error: {
            cleanupIncomplete: true,
            cleanupResources: [runtimeRoot],
            diagnostics: { leftover_paths: [runtimeRoot] },
          },
        });
        await expect(access(runtimeRoot)).resolves.toBeUndefined();
      } finally {
        await chmod(runtimeRoot, 0o700);
      }

      await expect(client.close()).resolves.toEqual({ ok: true, value: null });
      await expect(access(runtimeRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
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
  return process_ !== undefined && waitForChildExit(process_, 10_000);
};

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
    await expect(client.close()).resolves.toEqual({ ok: true, value: null });
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
      await expect(client.close()).resolves.toEqual({ ok: true, value: null });
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

it("preserves failed startup and retained Ghidra cleanup capabilities until a verified retry", async () => {
  const fixture = new FixtureLauncher("wrong_identity");
  let cleanupAllowed = false;
  let cleanupAttempts = 0;
  const launcher: GhidraLauncher = {
    launch: async (session) => {
      const launched = await fixture.launch(session);
      if (!launched.ok) return launched;
      return ok({
        ...launched.value,
        cleanup: async () => {
          cleanupAttempts += 1;
          return cleanupAllowed
            ? { cleaned: true as const, signaled: false }
            : {
                cleaned: false as const,
                reason: "fixture process cleanup unconfirmed",
              };
        },
      });
    },
  };
  const client = clientFor(launcher);
  onTestFinished(async () => {
    cleanupAllowed = true;
    await client.close();
  });
  expect(await client.start()).toMatchObject({
    ok: false,
    error: { kind: "protocol", cleanupFailure: { cleanupIncomplete: true } },
  });
  const runtime = fixture.runtimeRoots[0];
  if (runtime === undefined)
    throw new Error("Fixture runtime was not captured");
  await access(runtime);
  expect(cleanupAttempts).toBe(1);
  expect(await client.close()).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  cleanupAllowed = true;
  expect(await client.close()).toEqual(ok(null));
  expect(cleanupAttempts).toBe(3);
  await expect(access(runtime)).rejects.toMatchObject({ code: "ENOENT" });
});

describe.skipIf(process.platform === "win32")(
  "Ghidra launcher rollback ownership",
  () => {
    it.each([
      ["ownership manifest write failure", false, "start"],
      ["cancellation after process creation", true, "cancelled"],
    ] as const)(
      "retains the original process and runtime roots after %s until cleanup succeeds",
      async (failureMode, cancelAfterSpawn, expectedKind) => {
        const root = await createTestTempDirectory("rea-ghidra-rollback-");
        const java = join(root, "jdk", "bin", "java");
        await mkdir(join(root, "jdk", "bin"), { recursive: true });
        await writeFile(
          java,
          "#!/usr/bin/env node\n// LaunchSupport fixture emits no optional values.\n",
        );
        await chmod(java, 0o755);

        const controller = new AbortController();
        let cleanupAllowed = false;
        let cleanupAttempts = 0;
        let child: ChildProcess | undefined;
        let runtimeRoot: string | undefined;
        const headless = new GhidraHeadlessLauncher({
          environment: process.env,
          javaHome: join(root, "jdk"),
          analyzeHeadlessPath: "/unused/ghidra/support/analyzeHeadless",
          bridgeScriptPath: "/unused/rea/ReaGhidraBridge.java",
          spawnProcess: async ({ runId }) => {
            const spawned = spawn(
              process.execPath,
              ["-e", "setInterval(() => {}, 1000)"],
              { detached: true, stdio: ["ignore", "pipe", "pipe"] },
            );
            child = spawned;
            await new Promise<void>((resolve, reject) => {
              spawned.once("spawn", () => resolve());
              spawned.once("error", reject);
            });
            if (cancelAfterSpawn)
              controller.abort(new Error("rollback cancellation fixture"));
            const pid = spawned.pid;
            if (pid === undefined) throw new Error("fixture child has no PID");
            return {
              process: spawned,
              ownership: {
                runId,
                leaderPid: pid,
                processGroupId: pid,
                expectedParentPid: process.pid,
              },
              cleanup: async () => {
                cleanupAttempts += 1;
                if (!cleanupAllowed)
                  return {
                    cleaned: false as const,
                    reason: `${failureMode} cleanup is still unavailable`,
                  };
                if (spawned.exitCode === null && spawned.signalCode === null)
                  spawned.kill("SIGTERM");
                const exited = await waitForChildExit(spawned, 5_000);
                return exited
                  ? { cleaned: true as const, signaled: true }
                  : {
                      cleaned: false as const,
                      reason: "fixture child did not exit",
                    };
              },
            };
          },
        });
        const launcher: GhidraLauncher = {
          async launch(session, options) {
            runtimeRoot = session.runtimeRoot;
            if (!cancelAfterSpawn)
              await mkdir(join(session.runtimeRoot, "ownership.json"));
            return headless.launch(session, options);
          },
        };
        const client = clientFor(launcher);
        onTestFinished(async () => {
          cleanupAllowed = true;
          await client.close();
        });

        const started = await client.start(
          cancelAfterSpawn ? controller.signal : undefined,
        );
        expect(started).toMatchObject({
          ok: false,
          error: {
            kind: expectedKind,
            cleanupFailure: { cleanupIncomplete: true },
          },
        });
        if (started.ok) throw new Error("expected startup rollback failure");
        expect(started.error.message).toContain(
          cancelAfterSpawn ? "startup was cancelled" : "headless launch failed",
        );
        if (!cancelAfterSpawn)
          expect(started.error.message).toContain("ownership.json");
        if (runtimeRoot === undefined || child === undefined)
          throw new Error("fixture did not retain the started process owner");
        await access(runtimeRoot);
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        expect(cleanupAttempts).toBe(2);

        cleanupAllowed = true;
        await expect(client.close()).resolves.toEqual(ok(null));
        expect(cleanupAttempts).toBe(3);
        await expect(access(runtimeRoot)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(waitForExit(child)).resolves.toBe(true);
      },
    );
  },
);
