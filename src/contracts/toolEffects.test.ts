import { describe, expect, it } from "vitest";

import { TOOL_CONTRACTS } from "./toolContracts.js";
import {
  TOOL_EFFECTS,
  annotationsFromEffects,
  toolSessionEffects,
  type ToolEffects,
} from "./toolEffects.js";

describe("tool effects", () => {
  it("declares the web bundle worker's private file and child process effects", () => {
    const contract = TOOL_CONTRACTS.find(
      ({ name }) => name === "analyze_web_bundle",
    );
    expect(contract?.effects).toMatchObject({
      mutatesSession: true,
      accessesNetwork: true,
      launchesProcess: true,
      writesFilesystem: true,
      executesForeignCode: false,
      mutatesTarget: false,
    });
  });
  it("audits every public tool exactly once", () => {
    expect(Object.keys(TOOL_EFFECTS).sort()).toEqual(
      TOOL_CONTRACTS.map(({ name }) => name).sort(),
    );
  });

  it("marks foreign execution and device mutation as destructive", () => {
    const destructive = TOOL_CONTRACTS.filter(
      ({ effects }) => effects.executesForeignCode || effects.mutatesDevice,
    );
    expect(destructive.map(({ name }) => name).sort()).toEqual([
      "act_on_build_computer",
      "capture_browser_scenario",
      "capture_electron_scenario",
      "capture_native_ui_scenario",
      "capture_process_scenario",
      "close_frida_session",
      "close_gdb_session",
      "close_rizin_debug_session",
      "cutter_command",
      "execute_rizin_command",
      "gdb_console",
      "install_adb_package",
      "instrument_with_frida",
      "load_frida_script",
      "observe_native_calls",
      "push_adb_file",
      "resume_frida_session",
      "rizin_debug_command",
      "start_adb_activity",
      "start_adb_app",
      "start_build_computer",
      "start_rizin_debug_session",
      "stop_adb_app",
      "uninstall_adb_package",
    ]);
    for (const contract of destructive)
      expect(contract.annotations, contract.name).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
      });
  });

  it("derives destructiveHint from each destructive effect alone", () => {
    // Keep annotation algebra independent of any operation's audited effects.
    const base: ToolEffects = {
      mutatesTarget: false,
      mutatesSession: false,
      writesFilesystem: false,
      launchesProcess: false,
      accessesNetwork: false,
      changesUiState: false,
      mayDiscardData: false,
      executesForeignCode: false,
      mutatesDevice: false,
      idempotent: true,
    };
    expect(annotationsFromEffects(base)).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    for (const flag of [
      "mayDiscardData",
      "executesForeignCode",
      "mutatesDevice",
    ] as const)
      expect(annotationsFromEffects({ ...base, [flag]: true }), flag).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      });
  });

  it("marks automatic GDB detach as destructive target execution", () => {
    const effects = TOOL_EFFECTS["close_gdb_session"];
    if (effects === undefined)
      throw new Error("close_gdb_session is unaudited");
    expect(effects).toMatchObject({
      mutatesTarget: true,
      executesForeignCode: true,
    });
    expect(annotationsFromEffects(effects).destructiveHint).toBe(true);
  });

  it("publishes the advertised annotations derived from canonical effects", () => {
    for (const contract of TOOL_CONTRACTS)
      expect(contract.annotations, contract.name).toEqual(
        annotationsFromEffects(contract.effects),
      );
  });
});

it("advertises IDA provider effects while retaining session bases", () => {
  for (const name of [
    "procedure_pseudo_code",
    "procedure_assembly",
    "read_function_instructions",
    "analyze_function",
  ]) {
    expect(TOOL_EFFECTS[name], name).toMatchObject({
      mutatesSession: true,
      changesUiState: true,
      accessesNetwork: true,
    });
    expect(toolSessionEffects(name), name).toMatchObject({
      mutatesSession: true,
      changesUiState: false,
      accessesNetwork: false,
    });
    const contract = TOOL_CONTRACTS.find(
      (candidate) => candidate.name === name,
    );
    expect(contract?.annotations, name).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    });
  }
  for (const name of [
    "batch_decompile",
    "decompile_all",
    "trace_native_values",
    "inspect_native_api",
  ]) {
    expect(TOOL_EFFECTS[name], name).toMatchObject({
      changesUiState: true,
      accessesNetwork: true,
    });
    expect(toolSessionEffects(name), name).toMatchObject({
      changesUiState: false,
      accessesNetwork: false,
    });
  }
});

it("audits network access during lifecycle cleanup across provider changes", () => {
  for (const name of [
    "open_binary",
    "open_bundle_resources",
    "close_binary",
    "reset_investigation",
    "start_rizin_debug_session",
    "close_rizin_debug_session",
    "close_gdb_session",
  ]) {
    expect(toolSessionEffects(name).accessesNetwork, name).toBe(true);
    expect(TOOL_EFFECTS[name]?.accessesNetwork, name).toBe(true);
    expect(
      TOOL_CONTRACTS.find((contract) => contract.name === name)?.annotations
        .openWorldHint,
      name,
    ).toBe(true);
  }
});

it("advertises signature inspection's temporary snapshot filesystem writes", () => {
  expect(TOOL_EFFECTS.inspect_signature).toMatchObject({
    writesFilesystem: true,
    mutatesTarget: false,
    launchesProcess: true,
  });
});

it("advertises inspect_macho's temporary private operand filesystem writes", () => {
  expect(TOOL_EFFECTS.inspect_macho).toMatchObject({
    writesFilesystem: true,
    mutatesTarget: false,
    launchesProcess: true,
  });
});
