import { spawn, type ChildProcess } from "node:child_process";
import { getEventListeners } from "node:events";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ok } from "../src/domain/result.js";
import {
  GhidraClient,
  type GhidraDiagnostic,
} from "../src/ghidra/GhidraClient.js";
import type {
  GhidraLaunchSession,
  GhidraLauncher,
} from "../src/ghidra/GhidraLauncher.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/fakeGhidra.mjs", import.meta.url),
);
const PROFILE_DIGEST = "a".repeat(64);
const PROVIDER_VERSION = "12.1.2";

type FixtureMode =
  | "success"
  | "fragmented"
  | "wrong_identity"
  | "malformed"
  | "contradictory"
  | "oversized_whitespace"
  | "future_id"
  | "analysis_timeout"
  | "hang_after_start"
  | "silent"
  | "exit";

class FixtureLauncher implements GhidraLauncher {
  readonly runtimeRoots: string[] = [];
  readonly socketPaths: string[] = [];
  readonly tokens: string[] = [];
  readonly processes: ChildProcess[] = [];

  constructor(readonly mode: FixtureMode = "success") {}

  async launch(session: GhidraLaunchSession) {
    this.runtimeRoots.push(session.runtimeRoot);
    this.socketPaths.push(session.socketPath);
    this.tokens.push(session.token);
    const projectRoot = join(session.runtimeRoot, "project");
    await mkdir(projectRoot, { recursive: true });
    const process_ = spawn(
      process.execPath,
      [
        fixturePath,
        session.socketPath,
        session.token,
        session.runId,
        session.providerVersion,
        session.profileDigest,
        this.mode,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
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
    readonly requestTimeoutMs?: number;
    readonly onDiagnostic?: (event: GhidraDiagnostic) => void;
  } = {},
): GhidraClient => {
  const client = new GhidraClient({
    launcher,
    targetPath: "/tmp/fixture",
    providerVersion: PROVIDER_VERSION,
    profileDigest: PROFILE_DIGEST,
    startupTimeoutMs: options.startupTimeoutMs ?? 1_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 100,
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

    await expect(client.start()).resolves.toMatchObject({
      ok: true,
      value: {
        provider: { id: "ghidra", version: PROVIDER_VERSION },
        profile_digest: PROFILE_DIGEST,
        read_only: true,
        analysis_complete: true,
        analysis_timed_out: false,
        capabilities: ["ping", "shutdown"],
      },
    });
    expect(Buffer.byteLength(launcher.socketPaths[0] ?? "")).toBeLessThan(108);
  });

  it.each([
    ["wrong_identity", "protocol"],
    ["malformed", "protocol"],
    ["contradictory", "protocol"],
    ["oversized_whitespace", "protocol"],
    ["future_id", "protocol"],
    ["analysis_timeout", "analysis_timeout"],
    ["exit", "process"],
  ] as const)("projects %s startup as %s", async (mode, expectedKind) => {
    const client = clientFor(new FixtureLauncher(mode));
    const result = await client.start();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe(expectedKind);
  });

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
    expect(exited(launcher.processes[0])).toBe(true);
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
    expect(exited(launcher.processes[0])).toBe(true);
  });

  it("times out an established ping without corrupting shutdown", async () => {
    const client = clientFor(new FixtureLauncher("hang_after_start"));
    await expect(client.start()).resolves.toMatchObject({ ok: true });

    await expect(client.ping({ timeoutMs: 5 })).resolves.toMatchObject({
      ok: false,
      error: { kind: "timeout", timeoutMs: 5 },
    });
  });

  it("makes double close idempotent and detaches process listeners", async () => {
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
    expect(getEventListeners(process_, "exit")).toHaveLength(0);
    expect(getEventListeners(process_, "close")).toHaveLength(0);
    expect(getEventListeners(process_, "error")).toHaveLength(0);
    expect(process_.stdout).not.toBeNull();
    if (process_.stdout !== null)
      expect(getEventListeners(process_.stdout, "data")).toHaveLength(0);
  });

  it("retains actionable runtime coordinates after successful cleanup", async () => {
    const launcher = new FixtureLauncher();
    const client = clientFor(launcher);
    await expect(client.start()).resolves.toMatchObject({ ok: true });

    await client.close();

    expect(client.diagnostics()).toMatchObject({
      runtime_root: launcher.runtimeRoots[0],
      socket_path: launcher.socketPaths[0],
      project_root: join(launcher.runtimeRoots[0] ?? "", "project"),
      process_id: expect.any(Number),
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
    expect(encoded).toContain("/tmp/fixture");
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
