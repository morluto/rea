import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { PassThrough, Writable } from "node:stream";
import { resolve } from "node:path";

import {
  OwnedCommandFailure,
  prepareOwnedCommand,
  runOwnedCommand,
} from "../../dist/process/OwnedCommand.js";
import { ArtifactResourceScope } from "../../dist/artifacts/ArtifactResourceScope.js";
import { AnalysisCleanupLease } from "../../dist/artifacts/AnalysisCleanupLease.js";
import { retainOwnedCommandCleanup } from "../../dist/providers/OwnedCommandCleanup.js";

const SAFE_TOOL_ALLOWLIST = new Set([
  // Analysis settings
  "inspect_analysis_settings",
  "update_analysis_settings",
  // Cutter (read-only)
  "list_cutter_sessions",
  // Binary inspection
  "inspect_with_objdump",
  "inspect_desktop_application",
  "inspect_go_binary",
  "inspect_model_artifact",
  "inspect_gpu_code_objects",
  "inspect_rust_binary",
  "inspect_apk_signature",
  "inspect_python_pyc",
  "inspect_erlang_beam",
  "inspect_sqlite_database",
  "inspect_packet_fields",
  "inspect_packet_capture",
  "inspect_signal_decoders",
  "decode_signal_recording",
  "inspect_wasm_artifact",
  "inspect_evm_interface",
  "inspect_web_network_capture",
  "observe_web_execution",
  "inspect_web_event_listeners",
  "trace_web_source_location",
  "trace_web_module_imports",
  "inspect_recorded_crash",
  "inspect_binary_layout",
  // Frida (read-only)
  "list_frida_devices",
  "list_frida_processes",
  "frida_session_status",
  "load_frida_script",
  "resume_frida_session",
  "unload_frida_script",
  // Static native
  "inspect_byte_entropy",
  "inspect_pe_resources",
  "inspect_pe_certificates",
  "inspect_pe_imports",
  "inspect_native_exports",
  "inspect_elf_notes",
  "inspect_apple_ips",
  "inspect_devicetree",
  "inspect_kernel_module",
  "inspect_pe_load_config",
  "inspect_analysis_view",
  "inspect_firmware_regions",
  "inspect_android_package",
  "inspect_pcap_client",
  "inspect_pcap_capture",
  "identify_flutter_build",
  "inspect_dart_aot",
  "inspect_apktool_client",
  "decode_android_resources",
  "inspect_jeb_client",
  "open_jeb_project",
  "list_jeb_units",
  "decompile_jeb_item",
  // ADB (read-only)
  "inspect_adb_client",
  "list_adb_devices",
  "inspect_adb_device",
  "list_adb_packages",
  "list_adb_directory",
  "list_adb_features",
  "list_adb_services",
  "inspect_adb_display",
  "inspect_adb_window",
  "read_adb_setting",
  "collect_adb_bugreport",
  "resolve_adb_packages",
  // Android (read-only)
  "search_android_classes",
  "inspect_android_class",
  "inspect_android_method",
  "inspect_android_jni_bindings",
  "trace_android_references",
  "annotate_native_function",
  "inspect_native_load_image",
  "inspect_native_dispatch_metadata",
  "trace_native_ui_action",
  "trace_native_values",
  "address_name",
  "comment",
  "current_address",
  "current_procedure",
  "current_document",
  "inline_comment",
  "list_bookmarks",
  "list_documents",
  "list_names",
  "list_procedures",
  "list_segments",
  "list_strings",
  "next_address",
  "prev_address",
  "procedure_address",
  "procedure_assembly",
  "procedure_callees",
  "procedure_callers",
  "procedure_info",
  "read_function_instructions",
  "inspect_native_instruction",
  "inspect_native_data_type",
  "resolve_native_call_targets",
  "read_bytes",
  "search_bytes",
  "address_to_file_offset",
  "procedure_references",
  "procedure_pseudo_code",
  "resolve_containing_procedure",
  "search_procedures",
  "search_strings",
  // Native (read-only mutations)
  "set_address_name",
  "set_addresses_names",
  "set_bookmark",
  "set_comment",
  "set_inline_comment",
  "unset_bookmark",
  "xrefs",
  "get_objc_classes",
  "get_objc_protocols",
  "batch_decompile",
  "get_call_graph",
  "analyze_swift_types",
  "find_xrefs_to_name",
  "binary_overview",
  "analyze_function",
  "inspect_native_api",
  // Application analysis
  "trace_feature",
  "trace_call_path",
  // Binary session (read-only, launchesProcess is controlled)
  "open_binary",
  "open_bundle_resources",
  "close_binary",
  "reset_investigation",
  "binary_session",
  "export_evidence_bundle",
  "get_evidence_bundle",
  "get_navigation_context",
  "inspect_address_context",
  "import_evidence_bundle",
  // Browser (read-only)
  "list_browser_targets",
  "inspect_web_page",
  "analyze_web_bundle",
  "observe_web_session",
  "discover_webmcp_tools",
  "compare_web_captures",
  "capture_web_screenshot",
  "compare_web_screenshots",
  // Electron (read-only)
  "list_electron_targets",
  "inspect_electron_page",
  // JavaScript runtime
  "list_javascript_runtime_targets",
  "observe_javascript_runtime",
  "analyze_javascript_application",
  "inspect_electron_fuses",
  "export_web_scripts",
  // Environment
  "export_environment_bundle",
  "reconcile_javascript_runtime",
  "recover_javascript_sources",
  "trace_application_feature",
  "trace_javascript_semantics",
  "compare_application_versions",
  "search_guidance",
  "read_guidance_section",
  "guided_workflows",
  "compare_source_to_bundle",
  "compare_javascript_export_shapes",
  "build_reconstruction_obligation_ledger",
  "evaluate_reconstruction_coverage",
  "project_android_application_graph",
  "project_apple_application_graph",
  "project_harmony_application_graph",
  // Session
  "list_unknowns",
  "record_unknown",
  "update_unknown",
  "verify_unknown_resolution",
]);

/** Keep command ownership through failure and join cleanup before removing a run. */
export function createAgentEvaluationCommands({
  codex,
  claude = process.env.REA_AGENT_EVAL_CLAUDE_COMMAND ?? "claude",
  gemini = process.env.REA_AGENT_EVAL_GEMINI_COMMAND ?? "gemini",
  evaluationRoot,
  evaluationEnvironment,
  optionalModel,
  timeoutMs,
  repositoryRoot,
}) {
  const resources = new ArtifactResourceScope();
  const resourceOwner = {
    retain(owner, resource) {
      resources.retain({
        kind: "lease",
        resource,
        lease: AnalysisCleanupLease.forCloseOwner(owner, resource),
      });
    },
    run: (work) => resources.run(work),
  };
  const diagnosticBytes = 32_768;
  // npm installs of Gemini CLI provide a JavaScript entry point; on Windows only a
  // gemini.cmd shim reaches PATH, which Node does not spawn without a shell, so a
  // selected .js entry runs under this Node. Resolve it once, because the version
  // preflight runs from the repository root and the client from the evaluation root.
  const geminiEntryPoint = /\.(c|m)?js$/iu.test(gemini)
    ? resolve(gemini)
    : undefined;
  const launchGemini = (arguments_) =>
    geminiEntryPoint === undefined
      ? [gemini, arguments_]
      : [process.execPath, [geminiEntryPoint, ...arguments_]];

  async function execute(
    command,
    arguments_,
    cwd,
    env,
    limits,
    timeoutMessage,
  ) {
    return resourceOwner.run(async () => {
      try {
        // Fresh Darwin helper compilation has its own bounded deadline.
        await prepareOwnedCommand();
        return await runOwnedCommand(
          {
            command,
            arguments: arguments_,
            // CLI shims may execute through a shebang interpreter. Ownership
            // still uses the launch generation and token, not an argv prefix.
            expectedCommand: null,
            cwd,
            hostEnvironment: env,
            runId: randomUUID(),
            sweepTokenOwnedProcesses: true,
          },
          { diagnosticBytes, acceptNonZeroExit: true, ...limits },
        );
      } catch (cause) {
        retainOwnedCommandCleanup(
          cause,
          resourceOwner,
          "agent-evaluation",
          command,
        );
        if (cause instanceof OwnedCommandFailure && cause.reason === "timeout")
          throw new Error(timeoutMessage, { cause });
        throw cause;
      }
    });
  }

  async function executeJsonLines(
    command,
    arguments_,
    cwd,
    env,
    timeoutMessage,
  ) {
    const events = [];
    const nonJson = [];
    let nonJsonBytes = 0;
    const stdout = new PassThrough();
    const lines = createInterface({ input: stdout });
    const linesClosed = new Promise((resolve) =>
      lines.once("close", resolve),
    );
    let lineError;
    lines.on("error", (cause) => {
      lineError = cause;
      lines.close();
    });
    lines.on("line", (line) => {
      try {
        events.push(JSON.parse(line));
      } catch {
        if (nonJsonBytes >= diagnosticBytes) return;
        const bytes = Buffer.from(
          `non-json stdout: ${line.slice(0, diagnosticBytes - nonJsonBytes)}`,
        );
        const retained = bytes.subarray(0, diagnosticBytes - nonJsonBytes);
        if (retained.length > 0) nonJson.push(retained);
        nonJsonBytes += retained.length;
      }
    });
    try {
      const result = await execute(
        command,
        arguments_,
        cwd,
        env,
        { timeoutMs, stdout },
        timeoutMessage,
      );
      await linesClosed;
      if (lineError !== undefined) throw lineError;
      return {
        events,
        exitCode: result.exitCode ?? 1,
        stderr: Buffer.concat([...nonJson, Buffer.from(result.stderr.text)])
          .subarray(0, diagnosticBytes)
          .toString("utf8"),
      };
    } finally {
      stdout.destroy();
      lines.close();
      await linesClosed;
    }
  }

  const readVersion = async (
    command,
    arguments_,
    env,
    label = command,
  ) => {
    const result = await execute(
      command,
      arguments_,
      repositoryRoot,
      env,
      { timeoutMs: 10_000, diagnosticBytes: 8192 },
      `${label} --version timed out`,
    );
    if (result.exitCode !== 0)
      throw new Error(
        `${label} --version failed with ${String(result.exitCode)}: ${result.stderr.text}`,
      );
    const version = result.stdout.text.trim();
    if (version.length === 0)
      throw new Error(`${label} --version returned empty output`);
    return version;
  };

  return {
    async runCodex(prompt, approvedTools) {
      const arguments_ = [
        "--no-daemon",
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--json",
        "--color",
        "never",
        "-C",
        evaluationRoot,
        "-c",
        'approval_policy="never"',
        ...approvedTools.flatMap((name) => [
          "-c",
          `mcp_servers.rea.tools.${name}.approval_mode="approve"`,
        ]),
        ...(optionalModel === undefined ? [] : ["--model", optionalModel]),
        prompt,
      ];
      return executeJsonLines(
        codex,
        arguments_,
        evaluationRoot,
        evaluationEnvironment,
        `Codex evaluation timed out after ${String(timeoutMs)}ms`,
      );
    },

    async runClaude(prompt, approvedTools) {
      const allowedTools = new Set(SAFE_TOOL_ALLOWLIST);
      for (const tool of approvedTools) allowedTools.add(tool);
      return executeJsonLines(
        claude,
        [
          "--print",
          "--output-format",
          "stream-json",
          "--verbose",
          "--no-session-persistence",
          "--permission-mode",
          "acceptEdits",
          "--settings",
          JSON.stringify({
            permissions: {
              allow: ["Skill", "WaitForMcpServers", ...[...allowedTools].map((t) => `mcp__rea__${t}`)],
            },
          }),
          ...(optionalModel === undefined ? [] : ["--model", optionalModel]),
          "--",
          prompt,
        ],
        evaluationRoot,
        evaluationEnvironment,
        `Claude Code evaluation timed out after ${String(timeoutMs)}ms`,
      );
    },

    async runGemini(prompt, approvedTools) {
      const allowedTools = new Set(SAFE_TOOL_ALLOWLIST);
      for (const tool of approvedTools) allowedTools.add(tool);
      const [command, arguments_] = launchGemini([
        "--approval-mode",
        "default",
        "--allowed-mcp-server-names",
        "rea",
        "--output-format",
        "stream-json",
        ...(optionalModel === undefined ? [] : ["--model", optionalModel]),
        "-p",
        prompt,
      ]);
      return executeJsonLines(
        command,
        arguments_,
        evaluationRoot,
        evaluationEnvironment,
        `Gemini CLI evaluation timed out after ${String(timeoutMs)}ms`,
      );
    },

    async runProcess(command, arguments_, cwd, timeout, env = process.env) {
      const result = await execute(
        command,
        arguments_,
        cwd,
        env,
        {
          timeoutMs: timeout,
          stdout: new Writable({ write: (_chunk, _encoding, done) => done() }),
        },
        `${command} timed out`,
      );
      if (result.exitCode !== 0)
        throw new Error(
          `${command} failed with ${String(result.exitCode)}: ${result.stderr.text}`,
        );
    },

    async readCommandVersion(command, env = process.env) {
      return readVersion(command, ["--version"], env);
    },

    async readAgentVersion(client, env = evaluationEnvironment, arguments_ = ["--version"]) {
      const [command, args] =
        client === "gemini-cli"
          ? launchGemini(arguments_)
          : [client === "claude-code" ? claude : codex, arguments_];
      return readVersion(command, args, env, client);
    },

    close: () => resources.close(),
  };
}
