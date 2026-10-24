import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { Cli } from "incur";
import { expect, it, vi } from "vitest";
import { registerAdbCommands } from "../../src/cli/adbCommands.js";
import { createLogger } from "../../src/logger.js";
import { AnalysisProtocolError } from "../../src/domain/analysisErrorCore.js";
import { err } from "../../src/domain/result.js";
import { ok } from "../../src/domain/result.js";
import { createAnalysisExecution } from "../../src/application/AnalysisProvider.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../support/workspace/workspaceFixture.js";

it("cancels a real UI input-file read before further reads or device dispatch", async () => {
  const workspace = await createTestWorkspace("rea-adb-json-cancel-");
  const path = await workspace.write(
    "request.json",
    `${" ".repeat(9 * 1024 * 1024)}${JSON.stringify({ serial: "emulator-5554", package: "com.example.app" })}`,
  );
  const listeners = new Map<string, () => void>();
  const host = {
    exitCode: undefined as number | string | null | undefined,
    on(name: string, listener: () => void) {
      listeners.set(name, listener);
    },
    off(name: string) {
      listeners.delete(name);
    },
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reading!: () => void;
  const started = new Promise<void>((resolve) => {
    reading = resolve;
  });
  let handle: FileHandle | undefined;
  let reads = 0;
  let dispatches = 0;
  const open = fs.open;
  const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const opened = await open(...args);
    if (String(args[0]) === path) {
      handle = opened;
      const read = opened.read;
      vi.spyOn(opened, "read").mockImplementation(async (...parameters) => {
        reads++;
        if (reads === 1) {
          reading();
          await gate;
        }
        return Reflect.apply(read, opened, parameters);
      });
    }
    return opened;
  });
  syncBuiltinESMExports();
  const previousExitCode = process.exitCode;
  let serving: Promise<unknown> | undefined;
  try {
    const cli = Cli.create("rea-adb-json-test", { sync: false });
    registerAdbCommands(
      cli,
      createLogger("cli", "silent"),
      {},
      {
        async inspectAvailability() {
          return {
            status: "available",
            code: null,
            reason: null,
            diagnostics: {},
          };
        },
        async execute() {
          dispatches++;
          return err(
            new AnalysisProtocolError("Device dispatch must not occur"),
          );
        },
        async close() {},
      },
      host,
    );
    let stdout = "";
    serving = cli.serve(["inspect-adb-ui", path, "--json"], {
      env: {},
      exit() {},
      stdout(text) {
        stdout += text;
      },
    });
    await Promise.race([
      started,
      serving.then(() => {
        throw new Error("The file-read boundary was not reached");
      }),
    ]);
    expect(listeners.has("SIGINT")).toBe(true);
    listeners.get("SIGINT")!();
    release();
    await serving;
    expect(JSON.parse(stdout), stdout).toMatchObject({
      code: "cancelled",
      category: "cancelled",
      details: { operation: "inspect_adb_ui" },
    });
    expect(host.exitCode).toBe(130);
    expect(reads).toBe(1);
    expect(dispatches).toBe(0);
    expect(handle?.fd).toBe(-1);
    expect(listeners.size).toBe(0);
  } finally {
    release();
    await serving?.catch(() => {});
    spy.mockRestore();
    syncBuiltinESMExports();
    process.exitCode = previousExitCode;
    if (handle !== undefined && handle.fd >= 0) await handle.close();
    await removeTestWorkspace(workspace.root);
  }
});

it("retains completed ADB Evidence when interrupted during CLI provider close", async () => {
  const listeners = new Map<string, () => void>();
  const host = {
    exitCode: undefined as number | string | null | undefined,
    on(name: string, listener: () => void) {
      listeners.set(name, listener);
    },
    off(name: string) {
      listeners.delete(name);
    },
  };
  const previousExitCode = process.exitCode;
  try {
    const cli = Cli.create("rea-adb-close-cancel-test", { sync: false });
    registerAdbCommands(
      cli,
      createLogger("cli", "silent"),
      {},
      {
        async inspectAvailability() {
          return {
            status: "available",
            code: null,
            reason: null,
            diagnostics: {},
          };
        },
        async execute() {
          return ok(
            createAnalysisExecution(
              {
                client: {
                  binary_path: "/fixture/adb",
                  path_source: "environment",
                  version: "fixture",
                  installed_path: null,
                },
                contacted_adb_server: false,
              },
              { id: "adb", name: "ADB fixture", version: "fixture" },
            ),
          );
        },
        async close() {
          listeners.get("SIGINT")!();
        },
      },
      host,
    );
    let stdout = "";
    await cli.serve(["inspect-adb-client", "--json"], {
      env: {},
      exit() {},
      stdout(text) {
        stdout += text;
      },
    });
    expect(JSON.parse(stdout)).toMatchObject({
      code: "cancelled",
      details: {
        partial_observation: {
          operation: "inspect_adb_client",
          normalized_result: { contacted_adb_server: false },
        },
      },
    });
    expect(host.exitCode).toBe(130);
    expect(listeners.size).toBe(0);
  } finally {
    process.exitCode = previousExitCode;
  }
});
