import { writeFile } from "node:fs/promises";

import type { PhaseId, TargetKind } from "@rea-studio/core";
import { jsonSchema, tool, toolSearch, type JSONSchema7, type ToolSet } from "ai";

import {
  approve,
  clip,
  errorMessage,
  MODEL_RESULT_CHARS,
  preview,
  type ToolContext,
} from "./context.js";
import type { ReaSession } from "./rea.js";
import type { Workspace } from "./workspace.js";

export interface ReaToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
  readonly annotations?: { readonly destructiveHint?: boolean };
}

/** Evidence and session tools every phase may use. */
const COMMON = [
  "get_evidence_bundle",
  "export_evidence_bundle",
  "list_unknowns",
  "record_unknown",
  "update_unknown",
  "inspect_analysis_view",
];

/** Tools loaded up front per target kind; the rest stay searchable. */
const ANALYSIS_TOOLS: Record<TargetKind, readonly string[]> = {
  web: [
    "capture_browser_scenario",
    "list_browser_targets",
    "inspect_web_page",
    "observe_web_session",
    "inspect_web_network_capture",
    "analyze_web_bundle",
    "export_web_scripts",
    "trace_web_module_imports",
    "capture_web_screenshot",
    "discover_webmcp_tools",
  ],
  javascript: [
    "analyze_javascript_application",
    "trace_application_feature",
    "trace_javascript_semantics",
    "inspect_desktop_application",
    "inspect_electron_fuses",
    "capture_electron_scenario",
    "reconcile_javascript_runtime",
    "recover_javascript_sources",
    "analyze_web_bundle",
  ],
  android: [
    "inspect_android_package",
    "search_android_classes",
    "inspect_android_class",
    "inspect_android_method",
    "trace_android_references",
    "decode_android_resources",
    "project_android_application_graph",
    "inspect_apk_signature",
    "identify_flutter_build",
    "inspect_managed_artifact",
  ],
  native: [
    "inspect_artifact",
    "open_binary",
    "binary_overview",
    "binary_session",
    "list_procedures",
    "search_procedures",
    "procedure_pseudo_code",
    "analyze_function",
    "search_strings",
    "xrefs",
    "get_call_graph",
    "trace_feature",
    "close_binary",
  ],
};

const SPEC_TOOLS = [
  "build_reconstruction_obligation_ledger",
  "evaluate_reconstruction_coverage",
];

const VERIFY_TOOLS: Record<TargetKind, readonly string[]> = {
  web: ["capture_browser_scenario", "compare_web_captures", "inspect_web_page"],
  javascript: [
    "analyze_javascript_application",
    "compare_javascript_export_shapes",
    "capture_process_scenario",
    "compare_process_captures",
    "verify_reconstruction",
  ],
  android: ["capture_process_scenario", "compare_process_captures", "verify_reconstruction"],
  native: [
    "capture_process_scenario",
    "compare_process_captures",
    "compare_artifacts",
    "verify_reconstruction",
  ],
};

export interface ReaToolPlan {
  /** Sent with every request. */
  readonly eager: readonly string[];
  /** Discoverable through the search tool; undefined disables search. */
  readonly searchable: boolean;
}

/** Which REA tools a phase sees directly, and whether the rest are searchable. */
export const reaToolPlan = (phase: PhaseId, kind: TargetKind): ReaToolPlan => {
  switch (phase) {
    case "analysis":
      return { eager: [...ANALYSIS_TOOLS[kind], ...COMMON], searchable: true };
    case "spec":
      return { eager: [...SPEC_TOOLS, ...COMMON], searchable: false };
    case "build":
      return { eager: ["get_evidence_bundle", "list_unknowns"], searchable: true };
    case "verify":
      return { eager: [...VERIFY_TOOLS[kind], ...SPEC_TOOLS, ...COMMON], searchable: true };
    case "report":
      return { eager: ["get_evidence_bundle", "list_unknowns"], searchable: false };
  }
};

export interface ReaToolOptions {
  readonly kind: TargetKind;
  readonly phase: PhaseId;
  /** Secret ids the job declares, mapped to the env vars REA reads. */
  readonly secrets: Readonly<Record<string, string>>;
  readonly browserExecutable?: string;
}

const EVIDENCE_ID = /\bev_[A-Za-z0-9][A-Za-z0-9_-]{5,}/g;

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Declare the job's secrets on browser scenarios so the model only has to
 * reference them by id, drop declarations that point at other environment
 * variables, and fill in the detected browser executable.
 */
export const prepareScenarioInput = (
  input: Record<string, unknown>,
  options: Pick<ReaToolOptions, "secrets" | "browserExecutable">,
): Record<string, unknown> => {
  const allowed = new Set(Object.values(options.secrets));
  const declared = Array.isArray(input.secrets) ? input.secrets : [];
  const kept = declared.filter((entry) =>
    allowed.has(String(asRecord(entry).environment_variable ?? "")),
  );
  const ids = new Set(kept.map((entry) => String(asRecord(entry).secret_id)));
  for (const [secretId, variable] of Object.entries(options.secrets)) {
    if (!ids.has(secretId)) {
      kept.push({ secret_id: secretId, environment_variable: variable });
    }
  }
  const browser = asRecord(input.browser);
  const patchedBrowser =
    browser.mode === "launch" &&
    !browser.executable_path &&
    options.browserExecutable
      ? { ...browser, executable_path: options.browserExecutable }
      : input.browser;
  return {
    ...input,
    ...(patchedBrowser === undefined ? {} : { browser: patchedBrowser }),
    ...(kept.length > 0 ? { secrets: kept } : {}),
  };
};

const resultText = (result: Record<string, unknown>): string => {
  if ("toolResult" in result) return JSON.stringify(result.toolResult ?? null);
  const parts = Array.isArray(result.content) ? result.content : [];
  const texts = parts
    .map((part) => asRecord(part))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text));
  if (texts.length > 0) return texts.join("\n");
  return JSON.stringify(result.structuredContent ?? result.content ?? null);
};

/** Turn REA's MCP tools into AI SDK tools for one phase. */
export const reaTools = (
  session: ReaSession,
  definitions: readonly ReaToolDefinition[],
  ws: Workspace,
  ctx: ToolContext,
  options: ReaToolOptions,
): ToolSet => {
  const plan = reaToolPlan(options.phase, options.kind);
  const eager = new Set(plan.eager);
  const tools: ToolSet = {};
  for (const definition of definitions) {
    const isEager = eager.has(definition.name);
    if (!isEager && !plan.searchable) continue;
    const destructive = definition.annotations?.destructiveHint === true;
    tools[definition.name] = tool({
      description: definition.description ?? definition.name,
      inputSchema: jsonSchema(definition.inputSchema as JSONSchema7),
      ...(isEager ? {} : { deferLoading: true }),
      execute: async (rawInput: unknown, { toolCallId, abortSignal }) => {
        let input = asRecord(rawInput);
        if (definition.name === "capture_browser_scenario") {
          input = prepareScenarioInput(input, options);
        }
        const shown = preview(ctx.redactor.redact(JSON.stringify(input)));
        ctx.emit({
          type: "tool-call",
          phase: ctx.phase,
          toolCallId,
          tool: definition.name,
          source: "rea",
          input: shown,
        });
        if (destructive) {
          const decision = await approve(
            ctx,
            "tool",
            `REA tool ${definition.name}`,
            `This tool can run the target or change analysis state.\nInput: ${shown}`,
          );
          if (!decision.approved) {
            ctx.emit({
              type: "tool-result",
              phase: ctx.phase,
              toolCallId,
              tool: definition.name,
              ok: false,
              preview: "Declined by the user.",
            });
            return `The user declined this ${definition.name} call.${decision.note ? ` Note: ${decision.note}` : ""}`;
          }
        }
        try {
          const result: Record<string, unknown> = await session.client.callTool({
            name: definition.name,
            arguments: input,
            options: { signal: abortSignal ?? ctx.signal },
          });
          const text = ctx.redactor.redact(resultText(result));
          const seq = String(ctx.nextSeq()).padStart(4, "0");
          const savedTo = `evidence/${seq}-${definition.name}.json`;
          await writeFile(
            ws.path(savedTo),
            ctx.redactor.redact(JSON.stringify(result, null, 2)),
            "utf8",
          );
          const evidenceIds = [...new Set(text.match(EVIDENCE_ID) ?? [])].slice(0, 50);
          const ok = result.isError !== true;
          ctx.emit({
            type: "tool-result",
            phase: ctx.phase,
            toolCallId,
            tool: definition.name,
            ok,
            preview: preview(text),
            ...(evidenceIds.length ? { evidenceIds } : {}),
            savedTo,
          });
          const note =
            text.length > MODEL_RESULT_CHARS
              ? `\n[Full result saved to ${savedTo}; page through it with read_file.]`
              : `\n[Saved to ${savedTo}.]`;
          // REA marks target-derived content untrusted: data, never instructions.
          return `<rea_result tool="${definition.name}" ok="${ok}" untrusted="true">\n${clip(text, MODEL_RESULT_CHARS)}\n</rea_result>${note}`;
        } catch (cause: unknown) {
          const message = ctx.redactor.redact(errorMessage(cause));
          ctx.emit({
            type: "tool-result",
            phase: ctx.phase,
            toolCallId,
            tool: definition.name,
            ok: false,
            preview: preview(message),
          });
          return `REA tool ${definition.name} failed: ${message}`;
        }
      },
    });
  }
  if (plan.searchable) {
    tools.search_rea_tools = toolSearch({ maxResults: 8 });
  }
  return tools;
};
