#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import {
  isProviderId,
  parseJobSpec,
  splitCookieExport,
  type JobEvent,
  type JobSecrets,
  type ModelConfig,
  type PhaseId,
} from "@rea-studio/core";

import type { ApprovalGate } from "./context.js";
import { runJob } from "./pipeline.js";
import { listProviderModels, testConnection } from "./providers.js";

const USAGE = `rea-studio — drive REA with any model

Commands:
  run          Clone and enhance a target
  test-model   Check that a model answers and can call tools
  models       List the models a provider advertises

Model options (all commands):
  --provider <openai|anthropic|google|openrouter|ollama|openai-compatible>
  --model <id>            --base-url <url>      --api-key-env <VAR>
  --build-provider, --build-model, --build-base-url, --build-api-key-env
                          optional stronger model for spec/build/verify/report

run options:
  --kind <web|javascript|android|native>   --url <url> | --path <file>
  --title <text>          --scope <full|feature|api>   --scope-description <text>
  --port <language[:framework]>   --stack <text>   --harden <tests,security,…>
  --instructions <text>
  --login-url <url>  --username-env <VAR>  --password-env <VAR>
  --cookies-file <exported-cookies.json>   --cdp-port <port>
  --workspace <dir>       --phases <analysis,spec,…>
  --max-steps <n>         --max-tokens <n>
  --yes                   approve tools, commands and the spec automatically
  --i-am-authorized       confirm you own or may analyze the target (required)

Secrets are read from the environment variables you name, never from flags.`;

const options = {
  provider: { type: "string" },
  model: { type: "string" },
  "base-url": { type: "string" },
  "api-key-env": { type: "string" },
  "build-provider": { type: "string" },
  "build-model": { type: "string" },
  "build-base-url": { type: "string" },
  "build-api-key-env": { type: "string" },
  kind: { type: "string" },
  url: { type: "string" },
  path: { type: "string" },
  title: { type: "string" },
  scope: { type: "string", default: "full" },
  "scope-description": { type: "string", default: "" },
  port: { type: "string" },
  stack: { type: "string" },
  harden: { type: "string" },
  instructions: { type: "string" },
  "login-url": { type: "string" },
  "username-env": { type: "string" },
  "password-env": { type: "string" },
  "cookies-file": { type: "string" },
  "cdp-port": { type: "string" },
  workspace: { type: "string" },
  phases: { type: "string" },
  "max-steps": { type: "string", default: "60" },
  "max-tokens": { type: "string" },
  yes: { type: "boolean", default: false },
  "i-am-authorized": { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>["values"];

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

const envValue = (name: string | undefined, what: string): string | undefined => {
  if (!name) return undefined;
  const value = process.env[name];
  if (value === undefined) fail(`${what}: environment variable ${name} is not set.`);
  return value;
};

const modelConfig = (values: Values, prefix: "" | "build-"): ModelConfig | undefined => {
  const provider = values[`${prefix}provider`];
  const model = values[`${prefix}model`];
  if (!provider && !model) return undefined;
  if (!isProviderId(provider)) return fail(`Unknown provider ${provider}.`);
  if (!model) return fail(`--${prefix}model is required.`);
  const apiKey = envValue(values[`${prefix}api-key-env`], "API key");
  const baseURL = values[`${prefix}base-url`];
  return { provider, model, ...(apiKey ? { apiKey } : {}), ...(baseURL ? { baseURL } : {}) };
};

const printEvent = (event: JobEvent): void => {
  const out = (line: string) => process.stdout.write(`${line}\n`);
  switch (event.type) {
    case "phase":
      out(`\n== ${event.phase} ${event.status}${event.summary ? `: ${event.summary.slice(0, 300)}` : ""}`);
      break;
    case "text":
      out(`  ${event.text.slice(0, 400).replace(/\n/g, "\n  ")}`);
      break;
    case "tool-call":
      out(`  → ${event.tool} ${event.input.slice(0, 160)}`);
      break;
    case "tool-result":
      out(`  ${event.ok ? "✓" : "✗"} ${event.tool}${event.savedTo ? ` (${event.savedTo})` : ""}${event.evidenceIds?.length ? ` evidence: ${event.evidenceIds.slice(0, 3).join(", ")}` : ""}`);
      break;
    case "file":
      out(`  ✎ ${event.path}`);
      break;
    case "log":
      out(`  [${event.level}] ${event.message}`);
      break;
    case "done":
      out(`\nDone: ${event.status}${event.reportPath ? ` — report at ${event.reportPath}` : ""}${event.error ? ` — ${event.error}` : ""}`);
      break;
    default:
      break;
  }
};

const terminalGate = (autoApprove: boolean): ApprovalGate => ({
  async request(request) {
    if (autoApprove) return { approved: true };
    if (!process.stdin.isTTY) {
      return { approved: false, note: "No terminal to approve on; rerun with --yes." };
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write(`\n?? ${request.title}\n${request.detail.slice(0, 4_000)}\n`);
      const answer = (await rl.question("Approve? [y/N] ")).trim().toLowerCase();
      if (answer === "y" || answer === "yes") return { approved: true };
      const note = (await rl.question("Feedback for the agent (optional): ")).trim();
      return { approved: false, ...(note ? { note } : {}) };
    } finally {
      rl.close();
    }
  },
});

const run = async (values: Values): Promise<number> => {
  const analysis = modelConfig(values, "") ?? fail("--provider and --model are required.");
  const build = modelConfig(values, "build-") ?? analysis;
  const [language, framework] = (values.port ?? "").split(":");
  const cookies = values["cookies-file"]
    ? splitCookieExport(readFileSync(resolve(values["cookies-file"]), "utf8"))
    : undefined;
  const accessMode = values["cdp-port"]
    ? "connect"
    : cookies
      ? "storage"
      : values["password-env"]
        ? "password"
        : "none";
  const kind = values.kind ?? (values.url ? "web" : undefined);
  const spec = parseJobSpec({
    title: values.title ?? `Clone ${values.url ?? values.path ?? "target"}`,
    target: {
      kind,
      ...(values.url ? { url: values.url } : {}),
      ...(values.path ? { path: resolve(values.path) } : {}),
    },
    access: {
      mode: accessMode,
      ...(values["login-url"] ? { loginUrl: values["login-url"] } : {}),
      ...(values["cdp-port"] ? { cdpPort: Number(values["cdp-port"]) } : {}),
      ...(cookies ? { cookies: cookies.descriptors } : {}),
    },
    scope: { mode: values.scope, description: values["scope-description"] },
    enhancement: {
      ...(language ? { port: { language, ...(framework ? { framework } : {}) } } : {}),
      ...(values.stack ? { stack: values.stack } : {}),
      hardening: values.harden ? values.harden.split(",").map((item) => item.trim()) : [],
      ...(values.instructions ? { instructions: values.instructions } : {}),
    },
    budget: {
      maxStepsPerPhase: Number(values["max-steps"]),
      ...(values["max-tokens"] ? { maxTotalTokens: Number(values["max-tokens"]) } : {}),
    },
    approvals: {
      destructiveTools: values.yes ? "auto" : "ask",
      commands: values.yes ? "auto" : "ask",
      specReview: !values.yes,
    },
    authorizationAttested: values["i-am-authorized"],
  });
  const username = envValue(values["username-env"], "Username");
  const password = envValue(values["password-env"], "Password");
  const secrets: JobSecrets = {
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(cookies ? { cookieValues: cookies.values } : {}),
  };
  const workspaceRoot = resolve(
    values.workspace ?? `rea-studio-job-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  process.stdout.write(`Workspace: ${workspaceRoot}\n`);
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new Error("Interrupted.")));
  const result = await runJob({
    spec,
    secrets,
    models: { analysis, build },
    workspaceRoot,
    emit: printEvent,
    approvals: terminalGate(values.yes),
    signal: controller.signal,
    ...(values.phases ? { phases: values.phases.split(",") as PhaseId[] } : {}),
  });
  process.stdout.write(
    `Tokens: ${result.usage.totalTokens} (in ${result.usage.inputTokens}, out ${result.usage.outputTokens})\n`,
  );
  return result.status === "succeeded" ? 0 : 1;
};

const main = async (): Promise<number> => {
  const { values, positionals } = parseArgs({
    options,
    allowPositionals: true,
    strict: true,
  });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(`${USAGE}\n`);
    return command ? 0 : 2;
  }
  switch (command) {
    case "run":
      return run(values);
    case "test-model": {
      const config = modelConfig(values, "") ?? fail("--provider and --model are required.");
      const result = await testConnection(config);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.ok && result.toolCalling ? 0 : 1;
    }
    case "models": {
      if (!isProviderId(values.provider)) return fail("--provider is required.");
      const apiKey = envValue(values["api-key-env"], "API key");
      const ids = await listProviderModels({
        provider: values.provider,
        ...(apiKey ? { apiKey } : {}),
        ...(values["base-url"] ? { baseURL: values["base-url"] } : {}),
      });
      process.stdout.write(`${ids.join("\n")}\n`);
      return 0;
    }
    default:
      return fail(`Unknown command ${command}.\n\n${USAGE}`);
  }
};

main().then(
  (code) => process.exit(code),
  (cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exit(1);
  },
);
