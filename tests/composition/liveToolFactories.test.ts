import { readdir } from "node:fs/promises";

import { expect, it, vi } from "vitest";

import { createCutterBridgeService } from "../../src/composition/cutter.js";
import {
  createGdbSessionManager,
  createRizinDebugSessionManager,
} from "../../src/composition/debuggerSessions.js";
import { createFridaInstrumentationProvider } from "../../src/composition/frida.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it("keeps Frida binding acquisition lazy and one owner's shutdown local", async () => {
  // Only the binding boundary is simulated; neither native Frida nor a target
  // is acquired in this factory/lifetime test.
  const load = vi.fn(async () => {
    throw new Error("Authored fixture has no native Frida binding");
  });
  const first = createFridaInstrumentationProvider({
    deviceManagerLoader: load,
  });
  const second = createFridaInstrumentationProvider({
    deviceManagerLoader: load,
  });
  try {
    expect(load).not.toHaveBeenCalled();
    await first.closeAll();
    expect(load).not.toHaveBeenCalled();
    expect(await first.listDevices()).toMatchObject({
      ok: false,
      error: { reason: expect.stringContaining("shutting down") },
    });
    expect(load).not.toHaveBeenCalled();
    expect((await second.listDevices()).ok).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  } finally {
    await Promise.all([first.closeAll(), second.closeAll()]);
  }
});

it("gives Cutter compositions independent descriptor ownership without startup writes", async () => {
  const directory = await createTestTempDirectory("rea-cutter-factory-");
  const environment = { REA_CUTTER_BRIDGE_DIR: directory };
  const first = createCutterBridgeService(environment, { platform: "linux" });
  const second = createCutterBridgeService(environment, { platform: "linux" });
  try {
    expect(await readdir(directory)).toEqual([]);
    await first.close();
    // Closing one descriptor owner must not close another server/CLI owner's
    // read admission. The empty private directory requires no live bridge.
    expect((await first.listSessions()).ok).toBe(false);
    expect(await second.listSessions()).toMatchObject({
      ok: true,
      value: {
        bridge_directory: directory,
        discovery_status: "no_live_bridge_found",
        sessions: [],
      },
    });
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

it("keeps debugger lifetimes fresh and honors platform admission before any launch", async () => {
  const spawnProcess = vi.fn(async () => {
    throw new Error("A factory or unsupported host must not launch a debugger");
  });
  const gdb = [
    createGdbSessionManager({}, { platform: "win32", spawnProcess }),
    createGdbSessionManager({}, { platform: "win32", spawnProcess }),
  ] as const;
  const rizin = [
    createRizinDebugSessionManager({}, { platform: "win32", spawnProcess }),
    createRizinDebugSessionManager({}, { platform: "win32", spawnProcess }),
  ] as const;
  try {
    expect(spawnProcess).not.toHaveBeenCalled();
    await gdb[0].closeAll();
    await rizin[0].closeAll();
    expect(await gdb[0].start()).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    expect(await gdb[1].start()).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError" },
    });
    const input = { path: "fixture", inferior_tty: "fixture-tty" };
    expect(await rizin[0].start(input)).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
    expect(await rizin[1].start(input)).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError" },
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  } finally {
    await Promise.all([...gdb, ...rizin].map((owner) => owner.closeAll()));
  }
});
