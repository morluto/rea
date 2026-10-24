import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  compareInventory,
  runProductionMcpDoctor,
  runProductionMcpDoctorCli,
} from "../../../src/mcpDoctor.js";
import {
  FULL_CATALOG_IDENTITY,
  createCatalogIdentity,
} from "../../../src/catalogIdentity.js";
import { compactPresentationForMcpInputSchemaProfile } from "../../../src/config/mcpInputSchemaProfile.js";
import {
  MCP_PHASE_BUDGET_FLOOR_MS,
  MCP_PHASE_BUDGET_MAXIMUM_MS,
} from "../../../src/config/mcpStartupBudgets.js";
import { MCP_STARTUP_POLICY } from "../../../src/mcpStartupPolicy.js";

const expectDoctorDeadline = (
  detail: string | undefined,
  milliseconds: number,
) => {
  expect(detail).toContain("REA_MCP_DOCTOR_DEADLINE_MS");
  expect(detail).toContain(`${String(milliseconds)} ms (source setting`);
  expect(detail).toContain(
    `startup_timeout_sec of ${String(MCP_STARTUP_POLICY.codexStartupTimeoutSeconds)} seconds`,
  );
  expect(detail).not.toContain("no runtime override");
};

afterEach(() => vi.useRealTimers());

const assertCliCatalogIdentity = async (
  environment: NodeJS.ProcessEnv,
  identity: ReturnType<typeof createCatalogIdentity>,
) => {
  for (const command of ["capabilities", "providers"]) {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [resolve("scripts/rea.mjs"), command, "--json"],
      { env: environment, timeout: 15_000, maxBuffer: 1024 * 1024 },
    );
    const cliStatus: unknown = JSON.parse(stdout);
    expect(cliStatus, command).toMatchObject({
      server_identity: {
        catalog: { counts: identity.counts, digests: identity.digests },
      },
    });
  }
};

describe("production MCP doctor", () => {
  it("reuses immutable compiled profile digests and preserves custom-budget identity", async () => {
    // Exercise the generated module with Node, outside Vitest's source loader.
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
        import assert from "node:assert/strict";
        import { createCatalogIdentity, createCatalogDigests } from "./dist/catalogIdentity.js";
        import { RECORDED_CATALOG_DIGEST_PROFILES as profiles } from "./dist/recordedCatalogDigests.js";
        import { COMPACT_INPUT_SCHEMA_BUDGET_BYTES as budgetBytes } from "./dist/config/mcpInputSchemaProfile.js";
        assert.ok(Object.isFrozen(profiles));
        for (const input of ["full", "compact"]) {
          assert.ok(Object.isFrozen(profiles[input]));
          for (const output of ["full", "off"]) {
            const identity = createCatalogIdentity(input === "compact" ? { budgetBytes } : undefined, output);
            assert.equal(identity.digests, profiles[input][output]);
            assert.ok(Object.isFrozen(identity.digests));
          }
        }
        const selection = { budgetBytes: 1 };
        const custom = createCatalogIdentity(selection, "off");
        selection.budgetBytes = budgetBytes;
        const expected = createCatalogDigests(undefined, undefined, { budgetBytes: 1 }, "off");
        assert.deepEqual(custom.digests, expected);
        assert.notEqual(custom.digests.tools_sha256, profiles.compact.off.tools_sha256);
        assert.equal(custom.digests, custom.digests);
      `,
      ],
      { timeout: 30_000 },
    );
  }, 35_000);

  it("preserves the full-output envelope for startup failures", async () => {
    const result = await runProductionMcpDoctorCli(
      ["--json", "--full-output"],
      {
        dispatcherPath: resolve("tests/fixtures/mcpDoctorExit.mjs"),
        packageRoot: process.cwd(),
        stdoutIsTerminal: false,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: false,
      error: {
        healthy: false,
        checks: [{ name: "transport", ok: false }],
      },
      meta: {
        command: "rea mcp doctor",
        duration: expect.stringMatching(/^\d+ms$/u),
      },
    });
  });

  it.each([
    {
      name: "default compact input",
      environment: {
        REA_MCP_INPUT_SCHEMA_PROFILE: undefined,
        REA_MCP_OUTPUT_SCHEMA_PROFILE: "full",
      },
      identity: createCatalogIdentity(
        compactPresentationForMcpInputSchemaProfile(undefined),
      ),
    },
    {
      name: "full",
      environment: {
        REA_MCP_INPUT_SCHEMA_PROFILE: "full",
        REA_MCP_OUTPUT_SCHEMA_PROFILE: "full",
      },
      identity: FULL_CATALOG_IDENTITY,
    },
    {
      name: "compact",
      environment: {
        REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
        REA_MCP_OUTPUT_SCHEMA_PROFILE: "full",
      },
      identity: createCatalogIdentity(
        compactPresentationForMcpInputSchemaProfile("compact"),
      ),
    },
    {
      name: "output schemas off",
      environment: {
        REA_MCP_INPUT_SCHEMA_PROFILE: "full",
        REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
      },
      identity: createCatalogIdentity(undefined, "off"),
    },
    {
      name: "compact input and output schemas off",
      environment: {
        REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
        REA_MCP_OUTPUT_SCHEMA_PROFILE: "off",
      },
      identity: createCatalogIdentity(
        compactPresentationForMcpInputSchemaProfile("compact"),
        "off",
      ),
    },
  ])(
    "verifies the $name catalog through production stdio and both CLI inventories",
    async ({ environment, identity }) => {
      const result = await runProductionMcpDoctor({
        command: process.execPath,
        args: [resolve("scripts/rea.mjs"), "mcp"],
        cwd: process.cwd(),
        environment: { ...process.env, ...environment },
      });

      expect(result).toMatchObject({
        healthy: true,
        adapter: "production-stdio",
        inventory: {
          tools: {
            expected: expect.any(Number),
            observed: expect.any(Number),
            missing: [],
            unexpected: [],
          },
        },
        request_flow: { tool: "binary_session", ok: true },
      });
      expect(result.inventory?.tools.expected).toBe(
        result.inventory?.tools.observed,
      );
      expect(result.inventory?.tools.expected).toBe(
        FULL_CATALOG_IDENTITY.counts.mcp_tools,
      );
      expect(result.identity?.expected_catalog_digest).toBe(
        identity.digests.combined_sha256,
      );
      expect(result.identity?.observed_catalog_digest).toBe(
        identity.digests.combined_sha256,
      );
      await assertCliCatalogIdentity(
        { ...process.env, ...environment },
        identity,
      );
    },
    30_000,
  );
});

describe("production MCP doctor output", () => {
  it.each([false, true])(
    "frames unhealthy JSONL diagnostics and retains the selected envelope (%s)",
    async (full) => {
      const result = await runProductionMcpDoctorCli(
        ["--format", "jsonl", ...(full ? ["--full-output"] : [])],
        {
          dispatcherPath: resolve("tests/fixtures/mcpDoctorExit.mjs"),
          packageRoot: process.cwd(),
          stdoutIsTerminal: true,
        },
      );
      expect(result.exitCode).toBe(1);
      expect(result.output.trimEnd().split("\n")).toHaveLength(1);
      expect(JSON.parse(result.output)).toMatchObject({
        $rea: "jsonl/v1",
        type: "error",
        result: full
          ? {
              ok: false,
              error: { healthy: false },
              meta: { command: "rea mcp doctor" },
            }
          : { healthy: false },
      });
    },
  );

  it("frames JSONL validation errors before opening a diagnostic session", async () => {
    const result = await runProductionMcpDoctorCli(
      ["--format", "jsonl", "--unknown"],
      {
        dispatcherPath: "/must-not-start",
        packageRoot: process.cwd(),
        stdoutIsTerminal: false,
      },
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      $rea: "jsonl/v1",
      type: "error",
      result: { code: "VALIDATION_ERROR" },
    });
  });

  it.each([
    { name: "report", args: ["--json"] },
    { name: "full-output envelope", args: ["--json", "--full-output"] },
    { name: "validation error", args: ["--json", "--unknown"] },
  ])("indents $name JSON only for a terminal stdout", async ({ args }) => {
    const render = (stdoutIsTerminal: boolean) =>
      runProductionMcpDoctorCli(args, {
        dispatcherPath: resolve("tests/fixtures/mcpDoctorExit.mjs"),
        packageRoot: process.cwd(),
        stdoutIsTerminal,
      });
    const [redirected, terminal] = await Promise.all([
      render(false),
      render(true),
    ]);

    expect(redirected.output.split("\n")).toHaveLength(2);
    expect(redirected.output.endsWith("\n")).toBe(true);
    expect(terminal.output).toContain('\n  "');
    const withoutDuration = (output: string): unknown => {
      const value = JSON.parse(output) as { meta?: { duration?: string } };
      if (value.meta) delete value.meta.duration;
      return value;
    };
    expect(withoutDuration(redirected.output)).toEqual(
      withoutDuration(terminal.output),
    );
    expect(redirected.exitCode).toBe(terminal.exitCode);
  });
});

describe("production MCP doctor probe validation", () => {
  it("rejects a schema-invalid probe while retaining the discovered inventory", async () => {
    const root = await createTestTempDirectory("rea-mcp-doctor-reply-");
    const snapshotPath = join(root, "reply.json");
    // The replayed doctor validates structured replies against the advertised
    // output schema, so the captured definitions must select the full profile
    // explicitly; the replay environment is independent of the producer's.
    const environment = {
      PATH: process.env.PATH ?? "",
      REA_MCP_OUTPUT_SCHEMA_PROFILE: "full",
    };
    const client = new Client({ name: "doctor-reply-capture", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: environment,
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => undefined);
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      const prompts = await client.listPrompts();
      const toolDefinition = tools.tools.find(
        ({ name }) => name === "binary_session",
      );
      if (toolDefinition === undefined)
        throw new Error("Production binary_session contract is missing");
      const reply = await client.callTool(
        { name: "binary_session", arguments: {} },
        { toolDefinition },
      );
      await writeFile(
        snapshotPath,
        JSON.stringify({
          serverInfo: client.getServerVersion(),
          protocolVersion: client.getNegotiatedProtocolVersion(),
          tools,
          prompts,
          reply,
        }),
      );
    } finally {
      await client.close();
      await transport.close();
    }
    // Replay real production metadata through a synthetic stdio producer.
    for (const mode of ["valid", "invalid"]) {
      const result = await runProductionMcpDoctor({
        command: process.execPath,
        args: [
          resolve("tests/fixtures/mcpDoctorReply.mjs"),
          snapshotPath,
          mode,
        ],
        cwd: process.cwd(),
        environment,
      });
      expect(result.healthy).toBe(mode === "valid");
      expect(result.inventory?.tools.observed).toBe(
        FULL_CATALOG_IDENTITY.counts.mcp_tools,
      );
      expect(result.inventory?.prompts.observed).toBe(
        FULL_CATALOG_IDENTITY.counts.mcp_prompts,
      );
      expect(result.checks).toContainEqual({
        name: "initialize",
        ok: true,
        detail: expect.any(String),
      });
      if (mode === "invalid")
        expect(result.checks).toContainEqual({
          name: "request-flow",
          ok: false,
          detail: expect.stringMatching(/output schema/iu),
        });
    }
  }, 30_000);

  it("reports exact missing, unexpected, and duplicate inventory names", () => {
    expect(compareInventory(["a", "b"], ["b", "c", "c"])).toEqual({
      expected: 2,
      observed: 3,
      missing: ["a"],
      unexpected: ["c"],
      duplicates: ["c"],
    });
  });
});

describe("production MCP doctor child lifecycle", () => {
  it("captures startup exit diagnostics", async () => {
    const result = await runProductionMcpDoctor({
      command: process.execPath,
      args: [resolve("tests/fixtures/mcpDoctorExit.mjs")],
      cwd: process.cwd(),
      environment: process.env,
      deadlineMs: 2_000,
    });
    expect(result).toMatchObject({
      healthy: false,
      checks: [{ name: "transport", ok: false }],
      diagnostics: { stderr: expect.stringContaining("startup exit") },
    });
  });

  it("retains only the stderr prefix while draining and counting the full child stream", async () => {
    const result = await runNoisyDoctorChild(`
      for (let index = 0; index < 64; index += 1) {
        await new Promise((resolve, reject) => {
          process.stderr.write(Buffer.alloc(65_536, 0x78), (error) =>
            error ? reject(error) : resolve(),
          );
        });
      }
      process.exitCode = 1;
    `);

    expect(result.healthy).toBe(false);
    expect(result.diagnostics).toEqual({
      stderr: "x".repeat(MCP_STARTUP_POLICY.doctorStderrBytes),
      stderr_bytes: 4 * 1024 * 1024,
      stderr_truncated: true,
    });
  }, 10_000);

  it("does not manufacture a replacement character when the retained prefix ends inside UTF-8", async () => {
    const prefixBytes = MCP_STARTUP_POLICY.doctorStderrBytes - 1;
    const result = await runNoisyDoctorChild(`
      for (const chunk of [
        Buffer.alloc(${prefixBytes}, 0x78),
        Buffer.from([0xe2, 0x82, 0xac]),
      ]) {
        await new Promise((resolve, reject) => {
          process.stderr.write(chunk, (error) =>
            error ? reject(error) : resolve(),
          );
        });
      }
      process.exitCode = 1;
    `);

    expect(result.diagnostics).toEqual({
      stderr: "x".repeat(prefixBytes),
      stderr_bytes: prefixBytes + 3,
      stderr_truncated: true,
    });
  });

  it("preserves replacement decoding for malformed UTF-8 within an untruncated stream", async () => {
    const result = await runNoisyDoctorChild(`
      await new Promise((resolve, reject) => {
        process.stderr.write(Buffer.from([0xff]), (error) =>
          error ? reject(error) : resolve(),
        );
      });
      process.exitCode = 1;
    `);

    expect(result.diagnostics).toEqual({
      stderr: "�",
      stderr_bytes: 1,
      stderr_truncated: false,
    });
  });

  it("kills a child that misses the absolute startup deadline", async () => {
    const root = await createTestTempDirectory("rea-mcp-doctor-");
    const pidPath = join(root, "pid");
    // Keep filesystem/process I/O real. Advance only the deadline timers,
    // after the fixture proves it started and published its PID.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = runProductionMcpDoctor({
      command: process.execPath,
      args: [resolve("tests/fixtures/mcpDoctorHang.mjs")],
      cwd: process.cwd(),
      environment: { ...process.env, REA_MCP_DOCTOR_PID_PATH: pidPath },
      deadlineMs: 60_000,
    });
    const pid = await vi.waitFor(
      async () => {
        const value = Number.parseInt(await readFile(pidPath, "utf8"), 10);
        expect(Number.isSafeInteger(value) && value > 0).toBe(true);
        return value;
      },
      { timeout: 10_000 },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await vi.waitFor(() => pending, { timeout: 10_000 });
    vi.useRealTimers();
    expect(result.healthy).toBe(false);
    expectDoctorDeadline(result.checks[0]?.detail, 60_000);
    expect(result.checks[0]?.detail).toContain("client guidance");
    expect(result.checks[0]?.detail).not.toContain("REA_MCP_STARTUP");
    await expect(waitForExit(pid)).resolves.toBeUndefined();
  }, 10_000);
});

describe("production MCP doctor request-flow deadline", () => {
  it("names the applied deadline when binary_session exceeds it after the catalog", async () => {
    const root = await createTestTempDirectory("rea-mcp-doctor-session-");
    const readyPath = join(root, "ready");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = runProductionMcpDoctor({
      command: process.execPath,
      args: [resolve("tests/fixtures/mcpStartupProbeChild.mjs")],
      cwd: process.cwd(),
      environment: {
        ...process.env,
        REA_MCP_PROBE_MODE: "hang-on-call",
        REA_MCP_PROBE_READY_PATH: readyPath,
      },
      deadlineMs: 60_000,
    });
    await vi.waitFor(
      async () => {
        await readFile(readyPath, "utf8");
      },
      { timeout: 10_000 },
    );
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await vi.waitFor(() => pending, { timeout: 10_000 });
    vi.useRealTimers();
    expect(result.server).not.toBeNull();
    const requestFlow = result.checks.find(
      (check) => check.name === "request-flow",
    );
    expect(requestFlow?.ok).toBe(false);
    expectDoctorDeadline(requestFlow?.detail, 60_000);
    expect(requestFlow?.detail).toContain("client guidance");
    expect(requestFlow?.detail).not.toContain("source default");
    expect(requestFlow?.detail).not.toContain("REA_MCP_STARTUP");
  }, 15_000);

  it.each([
    "unrelated fixture method refusal",
    "Request timed out while reading a remote fixture",
    "Maximum total timeout exceeded in a remote operation",
    "Production MCP doctor deadline expired is remote diagnostic text",
  ])(
    "does not infer the doctor deadline from remote failure prose: %s",
    async (message) => {
      const result = await runProductionMcpDoctor({
        command: process.execPath,
        args: [resolve("tests/fixtures/mcpStartupProbeChild.mjs")],
        cwd: process.cwd(),
        environment: {
          ...process.env,
          REA_MCP_PROBE_MODE: "refuse-call",
          REA_MCP_PROBE_ERROR_MESSAGE: message,
        },
        deadlineMs: 5_000,
      });
      expect(result.server).not.toBeNull();
      const requestFlow = result.checks.find(
        (check) => check.name === "request-flow",
      );
      expect(requestFlow?.ok).toBe(false);
      expect(requestFlow?.detail).toContain(message);
      expect(requestFlow?.detail).not.toContain("no runtime override");
      expect(requestFlow?.detail).not.toContain("MCP doctor startup deadline");
    },
    10_000,
  );

  it("uses REA_MCP_DOCTOR_DEADLINE_MS when no caller deadline is passed", async () => {
    const root = await createTestTempDirectory("rea-mcp-doctor-setting-");
    const pidPath = join(root, "pid");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = runProductionMcpDoctor({
      command: process.execPath,
      args: [resolve("tests/fixtures/mcpDoctorHang.mjs")],
      cwd: process.cwd(),
      environment: {
        ...process.env,
        REA_MCP_DOCTOR_PID_PATH: pidPath,
        REA_MCP_DOCTOR_DEADLINE_MS: "2000",
      },
    });
    const pid = await vi.waitFor(
      async () => {
        const value = Number.parseInt(await readFile(pidPath, "utf8"), 10);
        expect(Number.isSafeInteger(value) && value > 0).toBe(true);
        return value;
      },
      { timeout: 10_000 },
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await vi.waitFor(() => pending, { timeout: 10_000 });
    vi.useRealTimers();
    expect(result.healthy).toBe(false);
    expectDoctorDeadline(result.checks[0]?.detail, 2_000);
    await expect(waitForExit(pid)).resolves.toBeUndefined();
  }, 10_000);

  it("refuses an invalid phase budget before starting a child", async () => {
    const result = await runProductionMcpDoctor({
      command: process.execPath,
      args: ["definitely-missing-mcp-doctor-child.mjs"],
      cwd: process.cwd(),
      environment: {
        ...process.env,
        REA_MCP_INITIALIZE_BUDGET_MS: "0",
        REA_MCP_DOCTOR_DEADLINE_MS: "0",
      },
    });
    expect(result.healthy).toBe(false);
    expect(result.server).toBeNull();
    expect(result.checks.map(({ name }) => name)).toEqual([
      "REA_MCP_INITIALIZE_BUDGET_MS",
      "REA_MCP_DOCTOR_DEADLINE_MS",
    ]);
    const budgetRange = `from ${String(MCP_PHASE_BUDGET_FLOOR_MS)} to ${String(MCP_PHASE_BUDGET_MAXIMUM_MS)} ms`;
    expect(result.checks[0]?.detail).toContain("REA_MCP_INITIALIZE_BUDGET_MS");
    expect(result.checks[0]?.detail).toContain(budgetRange);
    expect(result.checks[1]?.detail).toContain("REA_MCP_DOCTOR_DEADLINE_MS");
    expect(result.checks[1]?.detail).toContain(budgetRange);
    expect(result.checks[0]?.detail).not.toContain("no runtime override");
  });
});

const runNoisyDoctorChild = async (body: string) => {
  const root = await createTestTempDirectory("rea-mcp-doctor-stderr-");
  const scriptPath = join(root, "noisy.mjs");
  await writeFile(scriptPath, body);
  return runProductionMcpDoctor({
    command: process.execPath,
    args: [scriptPath],
    cwd: root,
    environment: process.env,
    deadlineMs: 5_000,
  });
};

const waitForExit = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (cause: unknown) {
      if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
        return;
      throw cause;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`MCP doctor fixture process ${String(pid)} remained alive`);
};
