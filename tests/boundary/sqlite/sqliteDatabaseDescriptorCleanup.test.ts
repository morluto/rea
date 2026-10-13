import { Cli } from "incur";
import { access, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished, vi } from "vitest";

import { SqliteDatabaseService } from "../../../src/application/sqlite/SqliteDatabaseService.js";
import { registerSqliteCommands } from "../../../src/cli/sqliteCommands.js";
import { createSqliteDatabaseService } from "../../../src/composition/sqlite.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { silentLogger } from "../../../src/logger.js";
import { SqliteDatabaseProvider } from "../../../src/sqlite/SqliteDatabaseProvider.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { createSqliteDatabaseFixture } from "../../fixtures/sqlite/database.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

const descriptorCleanup = vi.hoisted(() => ({
  path: "",
  denied: false,
  invalidate: false,
  attempts: 0,
  handles: [] as FileHandle[],
  readFailure: undefined as Error | undefined,
  onOpen: undefined as (() => void) | undefined,
}));

vi.mock("../../../src/composition/sqlite.js", () => ({
  createSqliteDatabaseService: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...filesystem,
    open: async (...args: Parameters<typeof filesystem.open>) => {
      const handle = await filesystem.open(...args);
      if (args[0] === descriptorCleanup.path) {
        descriptorCleanup.handles.push(handle);
        const close = handle.close.bind(handle);
        handle.close = async () => {
          // FileHandle.close also asks attached streams to close the invalidated handle.
          if (handle.fd < 0) {
            await close();
            return;
          }
          descriptorCleanup.attempts += 1;
          if (descriptorCleanup.denied) {
            if (descriptorCleanup.invalidate) await close();
            throw new Error("injected SQLite descriptor close failure");
          }
          await close();
        };
        if (descriptorCleanup.readFailure !== undefined)
          vi.spyOn(handle, "stat").mockRejectedValue(
            descriptorCleanup.readFailure,
          );
        descriptorCleanup.onOpen?.();
      }
      return handle;
    },
  };
});

const fixture = async (
  member: "database" | "WAL" | "journal" | "reply",
  invalidate = false,
) => {
  const workspace = await createTestWorkspace("rea-sqlite-descriptor-cleanup-");
  const database = createSqliteDatabaseFixture(workspace.root, true);
  const path =
    member === "database"
      ? database.path
      : member === "WAL"
        ? database.walPath
        : member === "journal"
          ? `${database.path}-journal`
          : "";
  if (member === "journal") await writeFile(path, Buffer.alloc(28));
  const roots: PrivateRuntimeRoot[] = [];
  const provider = new SqliteDatabaseProvider(
    process.env,
    (spawn) => {
      if (member !== "reply")
        throw new Error("SQLite worker deliberately unavailable");
      return spawnOwnedProviderProcess({
        ...spawn,
        arguments: spawn.arguments.map((argument, index) =>
          index === 1
            ? fileURLToPath(
                new URL(
                  "../../../dist/sqlite/SqliteDatabaseWorker.js",
                  import.meta.url,
                ),
              )
            : argument,
        ),
      });
    },
    async () => {
      const root = await PrivateRuntimeRoot.create({ parent: workspace.root });
      if (member === "reply")
        descriptorCleanup.path = join(root.path, "reply.json");
      roots.push(root);
      return root;
    },
  );
  descriptorCleanup.path = path;
  descriptorCleanup.denied = true;
  descriptorCleanup.invalidate = invalidate;
  descriptorCleanup.attempts = 0;
  descriptorCleanup.handles = [];
  descriptorCleanup.readFailure = undefined;
  descriptorCleanup.onOpen = undefined;
  onTestFinished(async () => {
    descriptorCleanup.denied = false;
    try {
      await provider.close();
    } catch (cause) {
      if (!invalidate) throw cause;
    }
    for (const handle of descriptorCleanup.handles) await handle.close();
    descriptorCleanup.path = "";
    database.close();
    await removeTestWorkspace(workspace.root);
  });
  return { provider, roots, path, database };
};

const serveInspection = async (
  provider: SqliteDatabaseProvider,
  path: string,
) => {
  const previousExitCode = process.exitCode;
  onTestFinished(() => {
    process.exitCode = previousExitCode;
  });
  vi.mocked(createSqliteDatabaseService).mockReturnValue(
    new SqliteDatabaseService(provider),
  );
  const cli = Cli.create("rea-sqlite-cleanup-test", { sync: false });
  registerSqliteCommands(cli, silentLogger, {});
  let stdout = "";
  await cli.serve(["inspect-sqlite-database", path, "--json"], {
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    exit: () => {},
  });
  return { output: JSON.parse(stdout) as unknown, exitCode: process.exitCode };
};

it.each(["database", "WAL", "journal"] as const)(
  "retains a failed %s descriptor and retries it at shutdown",
  async (member) => {
    const selected = await fixture(member);
    const first = await selected.provider.inspect({
      path: selected.database.path,
    });
    expect(first).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        cleanupResources: [expect.stringContaining(selected.path)],
      },
    });
    const handle = descriptorCleanup.handles[0];
    if (handle === undefined)
      throw new Error("Expected owned source descriptor");
    expect(handle.fd).toBeGreaterThanOrEqual(0);
    const blocked = await selected.provider.inspect({
      path: selected.database.path,
    });
    expect(blocked).toMatchObject({
      ok: false,
      error: { cleanupIncomplete: true },
    });
    expect(selected.roots).toHaveLength(1);
    await expect(selected.provider.close()).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    expect(descriptorCleanup.attempts).toBe(3);
    descriptorCleanup.denied = false;
    await selected.provider.close();
    expect(descriptorCleanup.attempts).toBe(4);
    expect(handle.fd).toBe(-1);
    for (const root of selected.roots)
      await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each(["EACCES", "EPERM"])(
  "retains the original %s inspection diagnostics through CLI shutdown",
  async (code) => {
    const selected = await fixture("database");
    descriptorCleanup.readFailure = Object.assign(
      new Error("injected source read denial"),
      { code },
    );
    const result = await serveInspection(
      selected.provider,
      selected.database.path,
    );
    expect(result).toMatchObject({
      exitCode: 1,
      output: {
        code: "cleanup_incomplete",
        details: {
          resources: [expect.stringContaining(selected.path)],
          diagnostics: {
            primary_error: {
              details: {
                diagnostics: {
                  previous_error: {
                    code: "access_denied",
                    details: { path: selected.path, system_code: code },
                  },
                },
              },
            },
            cleanup_error: { code: "cleanup_incomplete" },
          },
        },
      },
    });
    expect(descriptorCleanup.attempts).toBe(2);
  },
);

it("retains cancellation diagnostics and the interrupt exit code through CLI shutdown", async () => {
  const selected = await fixture("database");
  descriptorCleanup.onOpen = () => {
    const interrupt = process.listeners("SIGINT").at(-1);
    if (interrupt === undefined)
      throw new Error("Missing CLI interrupt handler");
    interrupt("SIGINT");
  };
  const result = await serveInspection(
    selected.provider,
    selected.database.path,
  );
  expect(result).toMatchObject({
    exitCode: 130,
    output: {
      code: "cleanup_incomplete",
      details: {
        resources: [expect.stringContaining(selected.path)],
        diagnostics: {
          primary_error: {
            details: {
              diagnostics: { previous_error: { code: "cancelled" } },
            },
          },
          cleanup_error: { code: "cleanup_incomplete" },
        },
      },
    },
  });
  expect(descriptorCleanup.attempts).toBeGreaterThanOrEqual(2);
});

it("retains reply-read cancellation and retries the failed reply descriptor close", async () => {
  const selected = await fixture("reply");
  const controller = new AbortController();
  descriptorCleanup.onOpen = () =>
    controller.abort(new Error("requested cancellation during reply read"));
  const result = await selected.provider.inspect(
    { path: selected.database.path },
    { signal: controller.signal },
  );
  if (result.ok) throw new Error("Expected cancelled reply read");
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      execution_failure: "cancelled",
      resources: [expect.stringContaining(descriptorCleanup.path)],
      captured_output: {
        stdout: "",
        stderr: expect.any(String),
        truncated: false,
      },
    },
  });
  const handle = descriptorCleanup.handles[0];
  if (handle === undefined) throw new Error("Expected owned reply descriptor");
  expect(handle.fd).toBeGreaterThanOrEqual(0);
  await expect(selected.provider.close()).rejects.toMatchObject({
    cleanupIncomplete: true,
  });
  descriptorCleanup.denied = false;
  await selected.provider.close();
  expect(handle.fd).toBe(-1);
  for (const root of selected.roots)
    await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retries source cleanup before admitting another snapshot", async () => {
  const selected = await fixture("database");
  await selected.provider.inspect({ path: selected.database.path });
  const first = descriptorCleanup.handles[0];
  if (first === undefined) throw new Error("Expected source descriptor");
  descriptorCleanup.denied = false;
  const resumed = await selected.provider.inspect({
    path: selected.database.path,
  });
  expect(selected.roots).toHaveLength(2);
  expect(first.fd).toBe(-1);
  if (resumed.ok) throw new Error("The worker is deliberately unavailable");
  expect(resumed.error.cleanupIncomplete).toBe(false);
  await selected.provider.close();
});

it("keeps an invalidated descriptor close failure unconfirmed across retries", async () => {
  const selected = await fixture("journal", true);
  const first = await selected.provider.inspect({
    path: selected.database.path,
  });
  expect(first).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  expect(descriptorCleanup.handles[0]?.fd).toBe(-1);
  descriptorCleanup.denied = false;
  await expect(selected.provider.close()).rejects.toMatchObject({
    cleanupIncomplete: true,
  });
  await expect(selected.provider.close()).rejects.toMatchObject({
    cleanupIncomplete: true,
  });
  expect(descriptorCleanup.attempts).toBe(1);
});

it.each(["EACCES", "EPERM"])(
  "preserves %s read diagnostics alongside a failed descriptor close",
  async (code) => {
    const selected = await fixture("database");
    descriptorCleanup.readFailure = Object.assign(
      new Error("injected source read denial"),
      { code },
    );
    const result = await selected.provider.inspect({
      path: selected.database.path,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        diagnostics: { previous_error: { code: "access_denied" } },
      },
    });
  },
);

it.each(["database", "WAL", "journal"] as const)(
  "preserves caller cancellation alongside a failed %s descriptor close",
  async (member) => {
    const selected = await fixture(member);
    const controller = new AbortController();
    descriptorCleanup.onOpen = () =>
      controller.abort(new Error("requested caller cancellation"));
    const result = await selected.provider.inspect(
      { path: selected.database.path },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        cleanupIncomplete: true,
        diagnostics: { previous_error: { code: "cancelled" } },
      },
    });
  },
);
