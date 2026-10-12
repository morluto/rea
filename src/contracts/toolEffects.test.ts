import { describe, expect, it } from "vitest";

import { TOOL_CONTRACTS } from "./toolContracts.js";
import { TOOL_EFFECTS, annotationsFromEffects } from "./toolEffects.js";

/**
 * Descriptions that name running, launching, executing, starting, installing,
 * or uninstalling something. A matching tool must declare foreign execution or
 * device mutation unless it is listed below with the reason the wording does
 * not describe that effect.
 */
const EXECUTION_WORDING =
  /\b(?:run|runs|running|launch|launches|launching|execute|executes|executing|execution|start|starts|install|installs|uninstall|uninstalls)\b/iu;

const EXECUTION_WORDING_EXCEPTIONS: Readonly<Record<string, string>> = {
  start_frida_session:
    "spawned targets remain suspended until resume_frida_session",
  inspect_native_load_image: "states that it does not execute the target",
  resolve_native_call_targets: "states that it does not execute code",
  inspect_pe_resources: "states that it does not execute the image",
  inspect_go_binary: "reads embedded metadata without executing the target",
  inspect_binary_layout:
    "parses the binary offline with operator-configured pwntools",
  inspect_recorded_crash: "inspects a core file without launching its target",
  inspect_macho: "runs host Mach-O inspection tools, not the target",
  inspect_evm_interface:
    "decodes bytecode in REA's bundled worker without executing it",
  inspect_wasm_artifact:
    "WABT validates and decompiles the module without executing it",
  identify_flutter_build:
    "identifies the build through execution-free APK parsing",
  inspect_dart_aot: "inspects snapshot bytes without executing them",
  inspect_analysis_view:
    "reports retained WASM execution/network states without performing execution",
  inspect_managed_artifact: "reads metadata without executing target code",
  inspect_managed_members: "reads metadata without executing target code",
  inspect_managed_native_boundaries:
    "reads metadata without executing target code",
  verify_managed_native_boundaries: "states it does not execute managed code",
  project_managed_application_graph: "states it does not execute managed code",
  inspect_android_package: "states it does not execute the APK",
  search_android_classes: "states it does not execute the APK",
  inspect_apktool_client:
    "inspects the operator-selected apktool launcher; never installs it",
  inspect_jeb_client: "talks to a caller-started JEB; never launches it",
  open_jeb_project: "the engine analyzes the file; REA does not execute it",
  inspect_adb_client:
    "inspects the operator-selected adb client; never starts its server",
  list_adb_devices: "may start the local adb server, which REA does not own",
  inspect_firmware_regions: "states there is no target execution",
  extract_firmware: "states that extracted code is never executed",
  analyze_javascript_application: "reconstructs the graph without executing",
  reconcile_javascript_runtime: "never invents execution claims",
  observe_javascript_runtime: "never evaluates or resumes the target",
  trace_application_feature: "never executes the application",
  trace_javascript_semantics: "static reachability never claims execution",
  compare_javascript_export_shapes: "states it does not execute JavaScript",
  project_android_application_graph: "execution-free inventory",
  project_apple_application_graph: "execution-free inventory",
  project_harmony_application_graph: "execution-free inventory",
  trace_web_source_location: "states there is no application execution",
  trace_web_module_imports:
    "runs only REA's resolver stub in operator-configured Chromium",
  export_web_scripts: "states there is no refetch or execution",
  observe_web_execution:
    "instruments an externally driven page; it does not run code itself",
  recover_javascript_sources: "states there is no application code execution",
  goto_address: "start names an object boundary, not a launch",
  prev_address: "start names an object boundary, not a launch",
  trace_call_path: "start names the traversal origin",
  observe_native_ui: "observes an already-running app without launching it",
  inspect_adb_package: "reports install times without changing the device",
  list_adb_processes: "lists running processes without changing the device",
  inspect_web_event_listeners: "states it does not evaluate JavaScript",
};

const declaresForeignAuthority = (name: string): boolean => {
  const effects = TOOL_EFFECTS[name];
  return (
    effects !== undefined &&
    (effects.executesForeignCode || effects.mutatesDevice)
  );
};

describe("tool effects", () => {
  it("audits every public tool exactly once", () => {
    expect(Object.keys(TOOL_EFFECTS).sort()).toEqual(
      TOOL_CONTRACTS.map(({ name }) => name).sort(),
    );
  });

  it("keeps execution and device wording aligned with declared effects", () => {
    const undeclared = TOOL_CONTRACTS.filter(
      ({ name, description }) =>
        EXECUTION_WORDING.test(description) &&
        !declaresForeignAuthority(name) &&
        EXECUTION_WORDING_EXCEPTIONS[name] === undefined,
    ).map(({ name }) => name);
    expect(undeclared).toEqual([]);
    const staleExceptions = Object.keys(EXECUTION_WORDING_EXCEPTIONS).filter(
      (name) => {
        const contract = TOOL_CONTRACTS.find(
          (candidate) => candidate.name === name,
        );
        return (
          contract === undefined ||
          !EXECUTION_WORDING.test(contract.description) ||
          declaresForeignAuthority(name)
        );
      },
    );
    expect(staleExceptions).toEqual([]);
  });

  it("marks foreign execution and device mutation as destructive", () => {
    const destructive = TOOL_CONTRACTS.filter(
      ({ effects }) => effects.executesForeignCode || effects.mutatesDevice,
    );
    expect(destructive.map(({ name }) => name).sort()).toEqual([
      "capture_browser_scenario",
      "capture_electron_scenario",
      "capture_native_ui_scenario",
      "capture_process_scenario",
      "install_adb_package",
      "instrument_with_frida",
      "load_frida_script",
      "observe_native_calls",
      "push_adb_file",
      "resume_frida_session",
      "start_adb_activity",
      "start_adb_app",
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
    const base = TOOL_EFFECTS["binary_session"];
    if (base === undefined) throw new Error("binary_session is unaudited");
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

  it("publishes the advertised annotations derived from canonical effects", () => {
    for (const contract of TOOL_CONTRACTS)
      expect(contract.annotations, contract.name).toEqual(
        annotationsFromEffects(contract.effects),
      );
  });
});
