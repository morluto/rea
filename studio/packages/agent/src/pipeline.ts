import { cp, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import {
  PHASES,
  estimateTokenCost,
  type JobSecrets,
  type JobSpec,
  type ModelConfig,
  type PhaseId,
} from "@rea-studio/core";
import {
  isStepCount,
  ToolLoopAgent,
  type LanguageModel,
  type ToolSet,
} from "ai";

import { detectBrowserExecutable } from "./browser.js";
import {
  errorMessage,
  type ApprovalGate,
  type Emit,
  type ToolContext,
} from "./context.js";
import {
  baseInstructions,
  phasePrompt,
  type PromptContext,
} from "./prompts.js";
import { createLanguageModel } from "./providers.js";
import { startRea, type ReaLaunch, type ReaSession } from "./rea.js";
import { reaTools, type ReaToolDefinition } from "./reaTools.js";
import { Redactor } from "./redact.js";
import { loadSkill, referenceTool } from "./skill.js";
import { Workspace, workspaceTools } from "./workspace.js";

export interface RunJobOptions {
  readonly spec: JobSpec;
  readonly secrets: JobSecrets;
  readonly models: {
    readonly analysis: ModelConfig;
    readonly build: ModelConfig;
  };
  readonly workspaceRoot: string;
  readonly emit: Emit;
  readonly approvals: ApprovalGate;
  readonly signal: AbortSignal;
  readonly launch?: ReaLaunch;
  /** Override model construction, e.g. with a mock model in tests. */
  readonly createModel?: (config: ModelConfig) => LanguageModel;
  /** Run only these phases (defaults to all five). */
  readonly phases?: readonly PhaseId[];
  readonly onUsage?: (usage: Usage) => void;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  unpricedTokens?: number;
}

export interface RunJobResult {
  readonly status: "succeeded" | "failed" | "cancelled";
  readonly reportPath?: string;
  readonly error?: string;
  readonly usage: Usage;
}

/** File each phase must leave behind; missing files get the model's final text. */
const PHASE_OUTPUT: Record<PhaseId, string> = {
  analysis: "notes/analysis.md",
  spec: "spec/feature-spec.md",
  build: "output/README.md",
  verify: "spec/verification.md",
  report: "output/REPORT.md",
};

const PHASE_MODEL: Record<PhaseId, "analysis" | "build"> = {
  analysis: "analysis",
  spec: "build",
  build: "build",
  verify: "build",
  report: "build",
};

const PHASE_TOOLS: Record<PhaseId, { write: boolean; commands: boolean }> = {
  analysis: { write: true, commands: false },
  spec: { write: true, commands: false },
  build: { write: true, commands: true },
  verify: { write: true, commands: true },
  report: { write: true, commands: false },
};

const MAX_SPEC_REVISIONS = 3;

/** Secret ids the model may reference and the env vars REA reads them from. */
export const secretEnvironment = (
  secrets: JobSecrets,
): {
  env: Record<string, string>;
  ids: Record<string, string>;
  labels: Record<string, string>;
} => {
  const env: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const labels: Record<string, string> = {};
  const add = (id: string, value: string | undefined, label: string) => {
    if (!value) return;
    const variable = `STUDIO_SECRET_${id.toUpperCase()}`;
    env[variable] = value;
    ids[id] = variable;
    labels[id] = label;
  };
  add("username", secrets.username, "login username");
  add("password", secrets.password, "login password");
  secrets.cookieValues?.forEach((value, index) =>
    add(`cookie_${index}`, value, `cookie #${index} value`),
  );
  return { env, ids, labels };
};

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Copy a local target into input/ unless it already lives in the workspace. */
const stageInput = async (ws: Workspace, path: string): Promise<string> => {
  const source = resolve(path);
  const rel = relative(ws.root, source);
  if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
  const target = ws.path("input", basename(source));
  if (!(await exists(target))) {
    await cp(source, target, { recursive: true, errorOnExist: false });
  }
  return relative(ws.root, target);
};

const listAllTools = async (
  session: ReaSession,
): Promise<ReaToolDefinition[]> => {
  const tools: ReaToolDefinition[] = [];
  let cursor: string | undefined;
  do {
    const page = await session.client.listTools(
      cursor ? { params: { cursor } } : undefined,
    );
    tools.push(...(page.tools as ReaToolDefinition[]));
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
};

/**
 * Run one clone-and-enhance job: analysis → specification (with review) →
 * build → verification → report, each phase a tool loop with its own tools.
 */
export const runJob = async (options: RunJobOptions): Promise<RunJobResult> => {
  const { spec, emit } = options;
  const usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    unpricedTokens: 0,
  };
  const budget = new AbortController();
  const signal = AbortSignal.any([options.signal, budget.signal]);
  const ws = new Workspace(options.workspaceRoot);
  const secretEnv = secretEnvironment(options.secrets);
  const redactor = new Redactor([
    ...Object.entries(secretEnv.ids).map(([id, variable]) => ({
      value: secretEnv.env[variable] ?? "",
      label: id,
    })),
    { value: options.models.analysis.apiKey ?? "", label: "api_key" },
    { value: options.models.build.apiKey ?? "", label: "api_key" },
  ]);
  const safeEmit: Emit = (event) => emit(redactor.redactValue(event));
  let seq = 0;
  const ctx: ToolContext = {
    phase: "analysis",
    emit: safeEmit,
    redactor,
    approvals: options.approvals,
    policy: spec.approvals,
    signal,
    nextSeq: () => {
      seq += 1;
      return seq;
    },
  };
  const makeModel = options.createModel ?? createLanguageModel;
  const models = {
    analysis: makeModel(options.models.analysis),
    build: makeModel(options.models.build),
  };

  let session: ReaSession | undefined;
  let currentPhase: PhaseId = "analysis";
  try {
    await ws.prepare();
    await writeFile(ws.path("logs", "job.json"), JSON.stringify(spec, null, 2));
    const inputPath = spec.target.path
      ? await stageInput(ws, spec.target.path)
      : undefined;

    session = await startRea({
      kind: spec.target.kind,
      env: secretEnv.env,
      cwd: ws.root,
      logFile: ws.path("logs", "rea.log"),
      ...(options.launch ? { launch: options.launch } : {}),
    });
    const definitions = await listAllTools(session);
    safeEmit({
      type: "log",
      level: "info",
      message: `REA connected (${session.launch.source}: ${session.launch.command} ${session.launch.args.join(" ")}), ${definitions.length} tools available.`,
    });
    const skill = loadSkill(session.launch);
    if (!skill.instructions) {
      safeEmit({
        type: "log",
        level: "warn",
        message:
          "REA's agent skill was not found; continuing with Studio's own instructions.",
      });
    }
    const browserExecutable = detectBrowserExecutable();
    const prompt: PromptContext = {
      spec,
      secretIds: secretEnv.labels,
      ...(browserExecutable ? { browserExecutable } : {}),
      ...(inputPath ? { inputPath } : {}),
      reaInstructions: session.instructions,
      skillInstructions: skill.instructions,
      referenceNames: [...skill.references.keys()],
    };
    const instructions = `${baseInstructions(prompt)}\n\nWorkspace root (absolute): ${ws.root}\nWrite user-facing reports and explanations in ${spec.language === "es" ? "Spanish" : "English"}. Keep code identifiers and technical evidence unchanged.`;

    const runPhase = async (
      phase: PhaseId,
      feedback?: string,
    ): Promise<string> => {
      currentPhase = phase;
      ctx.phase = phase;
      const tools: ToolSet = {
        ...workspaceTools(ws, ctx, PHASE_TOOLS[phase]),
        ...reaTools(session as ReaSession, definitions, ws, ctx, {
          kind: spec.target.kind,
          phase,
          secrets: secretEnv.ids,
          ...(browserExecutable ? { browserExecutable } : {}),
        }),
        ...referenceTool(skill),
      };
      const agent = new ToolLoopAgent({
        model: models[PHASE_MODEL[phase]],
        instructions,
        tools,
        stopWhen: isStepCount(spec.budget.maxStepsPerPhase),
      });
      const result = await agent.generate({
        prompt: phasePrompt(phase, prompt, feedback),
        abortSignal: signal,
        onStepEnd: (step) => {
          const text = step.text.trim();
          if (text)
            safeEmit({ type: "text", phase, text: text.slice(0, 4_000) });
          const input = step.usage.inputTokens ?? 0;
          const output = step.usage.outputTokens ?? 0;
          usage.inputTokens += input;
          usage.outputTokens += output;
          usage.totalTokens += step.usage.totalTokens ?? input + output;
          const selected = options.models[PHASE_MODEL[phase]];
          const cost = estimateTokenCost(
            selected.pricing,
            input,
            output,
            step.usage.inputTokenDetails?.cacheReadTokens ?? 0,
            step.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
          );
          if (cost === undefined)
            usage.unpricedTokens = (usage.unpricedTokens ?? 0) + input + output;
          else usage.estimatedCostUsd = (usage.estimatedCostUsd ?? 0) + cost;
          safeEmit({
            type: "usage",
            phase,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalTokens: usage.totalTokens,
            stepInputTokens: input,
            stepOutputTokens: output,
            estimatedCostUsd: usage.estimatedCostUsd ?? 0,
            unpricedTokens: usage.unpricedTokens ?? 0,
            model: selected.model,
            provider: selected.provider,
          });
          options.onUsage?.({ ...usage });
          if (
            spec.budget.maxCostUsd !== undefined &&
            (usage.estimatedCostUsd ?? 0) >= spec.budget.maxCostUsd
          )
            budget.abort(
              new Error("The job reached its estimated cost budget."),
            );
          if (
            spec.budget.maxTotalTokens !== undefined &&
            usage.totalTokens > spec.budget.maxTotalTokens
          ) {
            budget.abort(new Error("The job exceeded its token budget."));
          }
        },
      });
      const expected = ws.path(PHASE_OUTPUT[phase]);
      if (!(await exists(expected)) && result.text.trim()) {
        await writeFile(expected, redactor.redact(result.text), "utf8");
        safeEmit({ type: "file", path: PHASE_OUTPUT[phase], action: "write" });
      }
      return result.text;
    };

    const phases = options.phases ?? PHASES.map((phase) => phase.id);
    for (const phase of phases) {
      if (signal.aborted) break;
      safeEmit({ type: "phase", phase, status: "started" });
      let summary = await runPhase(phase);
      if (phase === "spec" && spec.approvals.specReview) {
        for (let revision = 0; ; revision += 1) {
          const specText = await readFile(
            ws.path(PHASE_OUTPUT.spec),
            "utf8",
          ).catch(() => "(spec/feature-spec.md was not written)");
          const decision = await options.approvals.request({
            kind: "spec",
            title: "Review the specification before the build starts",
            detail: redactor.redact(specText.slice(0, 20_000)),
          });
          if (decision.approved) break;
          if (!decision.note || revision + 1 >= MAX_SPEC_REVISIONS) {
            throw new CancelledError("The specification was rejected.");
          }
          summary = await runPhase("spec", decision.note);
        }
      }
      safeEmit({
        type: "phase",
        phase,
        status: "finished",
        summary: redactor.redact(summary.trim().slice(0, 1_500)),
      });
    }

    if (signal.aborted) {
      const reason = budget.signal.aborted
        ? errorMessage(budget.signal.reason)
        : undefined;
      safeEmit({
        type: "phase",
        phase: currentPhase,
        status: "failed",
        ...(reason ? { summary: reason } : {}),
      });
      const status = budget.signal.aborted ? "failed" : "cancelled";
      safeEmit({ type: "done", status, ...(reason ? { error: reason } : {}) });
      return { status, ...(reason ? { error: reason } : {}), usage };
    }
    const reportPath = PHASE_OUTPUT.report;
    const hasReport = await exists(ws.path(reportPath));
    safeEmit({
      type: "done",
      status: "succeeded",
      ...(hasReport ? { reportPath } : {}),
    });
    return { status: "succeeded", ...(hasReport ? { reportPath } : {}), usage };
  } catch (cause: unknown) {
    const cancelled =
      cause instanceof CancelledError ||
      (options.signal.aborted && !budget.signal.aborted);
    const message = redactor.redact(
      budget.signal.aborted
        ? errorMessage(budget.signal.reason)
        : errorMessage(cause),
    );
    safeEmit({
      type: "phase",
      phase: currentPhase,
      status: "failed",
      summary: message,
    });
    const status = cancelled ? "cancelled" : "failed";
    safeEmit({ type: "done", status, error: message });
    return { status, error: message, usage };
  } finally {
    ws.stopAll();
    await session?.close().catch(() => undefined);
  }
};

export class CancelledError extends Error {}
