import { ok as javaProbeOk, ok } from "../../../src/domain/result.js";
import type { GhidraJavaObservation } from "../../../src/ghidra/GhidraJavaProbe.js";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import { LazyAnalysisProvider } from "../../../src/application/binary/LazyAnalysisProvider.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { SESSION_TOOL_CONTRACTS } from "../../../src/contracts/sessionToolContracts.js";
import { elf } from "../../../src/domain/binaryTarget.fixture.js";
import { GhidraClient } from "../../../src/ghidra/GhidraClient.js";
import type { GhidraInstallationHost } from "../../../src/ghidra/GhidraInstallation.js";
import type {
  GhidraLaunchSession,
  GhidraLauncher,
} from "../../../src/ghidra/GhidraLauncher.js";
import { GhidraProvider } from "../../../src/ghidra/GhidraProvider.js";
import {
  ghidraCheckpointOriginLimitations,
  ghidraHealthLimitations,
} from "../../../src/ghidra/GhidraProviderCapabilities.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { waitForExit } from "../../support/process/processFixture.js";

const fixturePath = fileURLToPath(
  new URL("../../fixtures/fakeGhidra.mjs", import.meta.url),
);

type FixtureLaunch = {
  child: ChildProcess;
  runtimeRoot: string;
  endpointPath: string;
};

class FixtureLauncher implements GhidraLauncher {
  readonly launches: FixtureLaunch[] = [];
  readonly requests: string[] = [];
  /** Extra handshake fields, one entry per launch in order. */
  readonly handshakeReports: Record<string, unknown>[] = [];
  cleanupAllowed = true;
  cleanupAttempts = 0;
  constructor(readonly mode: "success" | "checkpoint" = "success") {}

  async launch(session: GhidraLaunchSession) {
    const projectRoot = join(session.runtimeRoot, "project");
    await mkdir(projectRoot, { recursive: true });
    const child = spawn(process.execPath, [fixturePath], {
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
          handshakeReports: this.handshakeReports.shift() ?? {},
        }),
      },
    });
    this.launches.push({
      child,
      runtimeRoot: session.runtimeRoot,
      endpointPath: session.endpointPath,
    });
    child.on("message", (value: unknown) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "method" in value &&
        typeof value.method === "string"
      )
        this.requests.push(value.method);
    });
    return ok({
      process: child,
      ownsProcessLifetime: true as const,
      projectRoot,
      ghidraLogPath: join(session.runtimeRoot, "ghidra.log"),
      scriptLogPath: join(session.runtimeRoot, "script.log"),
      cleanup: async () => {
        this.cleanupAttempts += 1;
        if (!this.cleanupAllowed)
          return {
            cleaned: false as const,
            reason: "fixture cleanup is not yet confirmed",
          };
        const signaled = child.exitCode === null && child.signalCode === null;
        if (signaled) child.kill("SIGTERM");
        return (await waitForExit(child, 2_000))
          ? { cleaned: true as const, signaled }
          : { cleaned: false as const, reason: "fixture child did not exit" };
      },
    });
  }
}

const installationHost: GhidraInstallationHost = {
  platform: "linux",
  architecture: "x64",
  readText: () => "application.version=12.1.4\napplication.java.min=21\n",
  executable: () => true,
  probeJava: () =>
    javaProbeOk<GhidraJavaObservation>({
      osArch: "amd64",
      osName: "Linux",
      version: "21.0.11",
      major: 21,
      home: "/fixture/jdk-21",
      bits: 64,
      runtime: "jdk",
    }),
};

// Only installation discovery and the Java bridge are simulated. Requests use
// the production client, real child/socket and public MCP session routing.
const connectGhidra = async (checkpoints = false) => {
  const directory = await createTestTempDirectory("rea-ghidra-reopen-");
  const target = join(directory, "target.elf");
  const source = elf(2, 1, 62);
  await writeFile(target, source);
  const config = parseConfig({
    GHIDRA_INSTALL_DIR: "/fixture/ghidra_12.1.4_PUBLIC",
    REA_GHIDRA_STARTUP_TIMEOUT_MS: "5000",
    ...(checkpoints
      ? { REA_GHIDRA_CHECKPOINT_DIR: join(directory, "checkpoints") }
      : {}),
  });
  if (!config.ok) throw config.error;
  const launcher = new FixtureLauncher(checkpoints ? "checkpoint" : "success");
  const clients: GhidraClient[] = [];
  const provider = new GhidraProvider(
    config.value,
    silentLogger,
    {},
    installationHost,
    (options) => {
      const client = new GhidraClient({
        ...options,
        launcher,
        platform: process.platform,
      });
      clients.push(client);
      return client;
    },
  );
  const lazy = new LazyAnalysisProvider({
    identity: provider.identity(),
    capabilities: provider.capabilities(),
    load: () => Promise.resolve(provider),
  });
  const session = composeBinarySession(
    new AnalysisProviderRegistry([
      {
        identity: () => provider.identity(),
        capabilities: () => provider.capabilities(),
        inspectAvailability: () => provider.inspectAvailability(),
        inspectTargetSupport: (value) => provider.inspectTargetSupport(value),
        resolveAnalysisProfile: (value, options) =>
          provider.resolveAnalysisProfile(value, options),
        createClient: (value, profile, context) =>
          lazy.createClient(value, profile, context),
      },
    ]),
  );
  const server = createServer(
    { kind: "session", session },
    { logger: silentLogger },
  );
  const mcp = new Client({ name: "ghidra-reopen", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const close = async () => {
    launcher.cleanupAllowed = true;
    await Promise.allSettled([mcp.close(), server.close()]);
    const closed = await session.close();
    try {
      for (const client of clients)
        expect((await client.close()).ok).toBe(true);
      expect(closed.ok).toBe(true);
    } finally {
      for (const { child } of launcher.launches) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
        expect(await waitForExit(child, 2_000)).toBe(true);
      }
    }
    for (const launched of launcher.launches) await expectReleased(launched);
    expect(Buffer.compare(await readFile(target), source)).toBe(0);
  };
  try {
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
  } catch (cause) {
    await close();
    throw cause;
  }
  return {
    mcp,
    clients,
    launcher,
    close,
    open: () =>
      mcp.callTool({ name: "open_binary", arguments: { path: target } }),
    query: (addressSuffix: number) =>
      mcp.callTool({
        name: "list_strings",
        arguments: { address: `0x200${addressSuffix}` },
      }),
  };
};

const UNCOMMITTED_SEEDS = {
  analysis_seeds: {
    format: "rea-ghidra-seeds-v1",
    sha256: "b".repeat(64),
    entries: 1,
    function_created: 1,
    function_existing: 0,
    function_failed: 0,
    code_decoded: 0,
    code_failed: 0,
    label_applied: 0,
    label_failed: 0,
    unmapped: 0,
  },
};

const firstLaunch = (launcher: FixtureLauncher): FixtureLaunch => {
  const first = launcher.launches[0];
  if (first === undefined) throw new Error("Expected a running Ghidra fixture");
  return first;
};

const expectReleased = async ({
  child,
  runtimeRoot,
  endpointPath,
}: FixtureLaunch) => {
  expect(await waitForExit(child, 2_000)).toBe(true);
  await expect(access(runtimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(endpointPath)).rejects.toMatchObject({ code: "ENOENT" });
};

const disconnect = async (
  child: ChildProcess,
  client: GhidraClient | undefined,
) => {
  if (client === undefined)
    throw new Error("Expected a connected Ghidra client");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", received);
      reject(new Error("Fixture did not acknowledge socket disconnection"));
    }, 2_000);
    const received = (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("event" in message) ||
        message.event !== "disconnected"
      )
        return;
      clearTimeout(timer);
      child.off("message", received);
      resolve();
    };
    child.on("message", received);
    child.send("disconnect");
  });
  const disconnectedPing = await client.ping({ timeoutMs: 200 });
  expect(disconnectedPing.ok).toBe(false);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
};

describe.skipIf(process.platform === "win32")(
  "Ghidra checkpoint discoverability over MCP",
  () => {
    it.each([false, true])(
      "discovers checkpoint mode %s from the catalog and default summary before analysis",
      async (enabled) => {
        const harness = await connectGhidra(enabled);
        try {
          // Metadata discovery does not need the SDK's whole-catalog validator
          // cache. Check the relevant returned fields explicitly below.
          const catalog = z
            .object({
              tools: z.array(
                z.object({
                  name: z.string(),
                  description: z.string().optional(),
                }),
              ),
            })
            .parse(
              await harness.mcp.request({ method: "tools/list", params: {} }),
            );
          expect(
            catalog.tools.find(({ name }) => name === "open_binary")
              ?.description,
          ).toContain("REA_GHIDRA_CHECKPOINT_DIR");
          expect(
            catalog.tools.find(({ name }) => name === "close_binary")
              ?.description,
          ).toBe(
            SESSION_TOOL_CONTRACTS.find(({ name }) => name === "close_binary")
              ?.description,
          );
          expect((await harness.open()).isError).not.toBe(true);
          const status = await harness.mcp.callTool({
            name: "binary_session",
            arguments: {},
          });
          const parsed = z
            .object({
              result: z.object({
                detail: z.literal("summary"),
                capabilities: z.array(
                  z.object({
                    provider: z.object({ id: z.string() }),
                    shared_limitations: z.array(z.string()),
                  }),
                ),
              }),
            })
            .parse(status.structuredContent);
          const limitations = parsed.result.capabilities.find(
            ({ provider }) => provider.id === "ghidra",
          )?.shared_limitations;
          expect(limitations).toEqual(
            expect.arrayContaining([
              ...ghidraHealthLimitations(
                enabled ? "owned-checkpoint" : "fresh-import",
              ),
            ]),
          );
          expect(limitations?.join("\n")).toContain(
            "REA_GHIDRA_CHECKPOINT_DIR",
          );
          expect(harness.clients).toHaveLength(0);
          expect(harness.launcher.launches).toHaveLength(0);
          if (enabled) {
            const output = z.object({ limitations: z.array(z.string()) });
            const initial = output.parse(
              (await harness.query(1)).structuredContent,
            );
            expect(harness.clients[0]?.checkpointRestore()).toBeNull();
            expect(harness.launcher.requests).toContain("checkpoint_program");
            expect(initial.limitations).toEqual(
              expect.arrayContaining([
                ...ghidraCheckpointOriginLimitations(null),
              ]),
            );
            expect(
              (
                await harness.mcp.callTool({
                  name: "close_binary",
                  arguments: {},
                })
              ).isError,
            ).not.toBe(true);
            expect((await harness.open()).isError).not.toBe(true);
            const restored = output.parse(
              (await harness.query(2)).structuredContent,
            );
            const source = harness.clients[1]?.checkpointRestore();
            expect(source).toBeTruthy();
            if (!source)
              throw new Error("Expected a verified restored Program");
            expect(source.sha256).toBe(
              createHash("sha256")
                .update(await readFile(source.path))
                .digest("hex"),
            );
            expect(
              restored.limitations.some(
                (value) =>
                  value.includes(source.path) && value.includes(source.sha256),
              ),
            ).toBe(true);
            expect(restored.limitations).toEqual(
              expect.arrayContaining([
                ...ghidraCheckpointOriginLimitations(source),
              ]),
            );
            expect(restored.limitations).not.toEqual(
              expect.arrayContaining([
                ...ghidraCheckpointOriginLimitations(null),
              ]),
            );
          }
        } finally {
          await harness.close();
        }
      },
    );
  },
);

describe.skipIf(process.platform === "win32")(
  "Ghidra MCP session recovery over Unix sockets",
  () => {
    it("keeps open lazy, reuses a live child, and replaces an exited child on reopen", async () => {
      const harness = await connectGhidra();
      try {
        expect((await harness.open()).isError).not.toBe(true);
        expect((await harness.open()).isError).not.toBe(true);
        expect(harness.clients).toHaveLength(0);
        expect(harness.launcher.launches).toHaveLength(0);
        expect((await harness.query(1)).isError).not.toBe(true);
        const old = firstLaunch(harness.launcher);
        expect((await harness.open()).isError).not.toBe(true);
        expect((await harness.query(2)).isError).not.toBe(true);
        expect(harness.launcher.launches).toHaveLength(1);
        await expect
          .poll(
            () =>
              harness.launcher.requests.filter(
                (method) => method === "list_strings",
              ).length,
          )
          .toBe(2);
        expect(old.child.kill("SIGTERM")).toBe(true);
        expect(await waitForExit(old.child, 2_000)).toBe(true);
        expect(old.child.signalCode).toBe("SIGTERM");
        expect((await harness.open()).isError).not.toBe(true);
        await expectReleased(old);
        expect(harness.clients).toHaveLength(1);
        expect(harness.launcher.launches).toHaveLength(1);
        expect((await harness.query(3)).isError).not.toBe(true);
        expect(harness.clients).toHaveLength(2);
        expect(harness.launcher.launches).toHaveLength(2);
      } finally {
        await harness.close();
      }
    });

    it("retires a disconnected live child before lazily starting a replacement", async () => {
      const harness = await connectGhidra();
      try {
        expect((await harness.open()).isError).not.toBe(true);
        expect((await harness.query(1)).isError).not.toBe(true);
        const old = firstLaunch(harness.launcher);
        await disconnect(old.child, harness.clients[0]);
        expect((await harness.open()).isError).not.toBe(true);
        await expectReleased(old);
        expect(harness.clients).toHaveLength(1);
        expect(harness.launcher.launches).toHaveLength(1);
        expect((await harness.query(2)).isError).not.toBe(true);
        expect(harness.clients).toHaveLength(2);
        expect(harness.launcher.launches).toHaveLength(2);
      } finally {
        await harness.close();
      }
    });

    it("retains failed cleanup and refuses replacement until cleanup can be retried", async () => {
      const harness = await connectGhidra();
      try {
        expect((await harness.open()).isError).not.toBe(true);
        expect((await harness.query(1)).isError).not.toBe(true);
        const old = firstLaunch(harness.launcher);
        await disconnect(old.child, harness.clients[0]);
        harness.launcher.cleanupAllowed = false;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          expect(parseMcpToolError(await harness.open())).toMatchObject({
            error: { code: "cleanup_incomplete" },
          });
          expect(harness.launcher.cleanupAttempts).toBe(attempt);
          expect(harness.clients).toHaveLength(1);
          expect(harness.launcher.launches).toHaveLength(1);
          expect(old.child.exitCode).toBeNull();
          expect(old.child.signalCode).toBeNull();
          await access(old.runtimeRoot);
        }
        harness.launcher.cleanupAllowed = true;
        expect((await harness.open()).isError).not.toBe(true);
        await expectReleased(old);
        expect(harness.launcher.cleanupAttempts).toBe(3);
        expect(harness.clients).toHaveLength(1);
        expect(harness.launcher.launches).toHaveLength(1);
        expect((await harness.query(2)).isError).not.toBe(true);
        expect(harness.clients).toHaveLength(2);
        expect(harness.launcher.launches).toHaveLength(2);
      } finally {
        await harness.close();
      }
    });
  },
);

describe.skipIf(process.platform === "win32")(
  "Ghidra MCP handshake rejection over Unix sockets",
  () => {
    it("refuses an uncommitted handshake report before the first query and replaces that session on reopen", async () => {
      const harness = await connectGhidra();
      try {
        harness.launcher.handshakeReports.push(UNCOMMITTED_SEEDS);
        expect((await harness.open()).isError).not.toBe(true);
        expect(harness.launcher.launches).toHaveLength(0);
        expect(parseMcpToolError(await harness.query(1))).toMatchObject({
          error: {
            details: {
              operation: "list_strings",
              diagnostics: {
                reason: expect.stringContaining(
                  "reported analysis seeds that the profile did not commit",
                ),
              },
            },
          },
        });
        const rejected = firstLaunch(harness.launcher);
        await expectReleased(rejected);
        expect(harness.launcher.requests).not.toContain("list_strings");

        expect((await harness.query(2)).isError).toBe(true);
        expect(harness.launcher.launches).toHaveLength(1);
        expect(harness.launcher.requests).not.toContain("list_strings");

        expect((await harness.open()).isError).not.toBe(true);
        expect((await harness.query(3)).isError).not.toBe(true);
        expect(harness.clients).toHaveLength(2);
        expect(harness.launcher.launches).toHaveLength(2);
        await expect
          .poll(() =>
            harness.launcher.requests.filter(
              (method) => method === "list_strings",
            ),
          )
          .toHaveLength(1);
      } finally {
        await harness.close();
      }
    });

    it("retains a rejected session's failed cleanup and refuses replacement until it can be retried", async () => {
      const harness = await connectGhidra();
      try {
        harness.launcher.handshakeReports.push(UNCOMMITTED_SEEDS);
        harness.launcher.cleanupAllowed = false;
        expect((await harness.open()).isError).not.toBe(true);
        expect(parseMcpToolError(await harness.query(1))).toMatchObject({
          error: { code: "cleanup_incomplete" },
        });
        expect(harness.launcher.cleanupAttempts).toBe(1);
        expect(harness.launcher.requests).not.toContain("list_strings");
        const rejected = firstLaunch(harness.launcher);
        await access(rejected.runtimeRoot);

        expect(parseMcpToolError(await harness.open())).toMatchObject({
          error: { code: "cleanup_incomplete" },
        });
        expect(harness.launcher.cleanupAttempts).toBe(2);
        expect(harness.launcher.launches).toHaveLength(1);
        await access(rejected.runtimeRoot);

        harness.launcher.cleanupAllowed = true;
        expect((await harness.open()).isError).not.toBe(true);
        await expectReleased(rejected);
        expect((await harness.query(2)).isError).not.toBe(true);
        expect(harness.launcher.launches).toHaveLength(2);
      } finally {
        await harness.close();
      }
    });
  },
);
