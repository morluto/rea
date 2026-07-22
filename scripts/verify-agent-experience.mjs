import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { createPackage } from "@electron/asar";

import { evaluateCodexEvents } from "../dist/evaluation/CodexAgentEval.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evaluationRoot = await mkdtemp(join(tmpdir(), "rea-agent-eval-"));
const fixtureRoot = join(evaluationRoot, "targets");
const skillDestination = join(
  evaluationRoot,
  ".agents/skills/reverse-engineer-anything",
);
const timeoutMs = Number(process.env.REA_AGENT_EVAL_TIMEOUT_MS ?? 480_000);
const codex = process.env.REA_CODEX_CLI ?? "codex";
const optionalModel = process.env.REA_AGENT_EVAL_MODEL;

if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10_000)
  throw new Error("REA_AGENT_EVAL_TIMEOUT_MS must be an integer >= 10000");
const codexVersion = await readCommandVersion(codex);

try {
  await mkdir(fixtureRoot, { recursive: true });
  await cp(
    join(repositoryRoot, "skills/reverse-engineer-anything"),
    skillDestination,
    { recursive: true },
  );
  const targets = await createTargets(fixtureRoot);
  const allScenarios = [
    {
      id: "native",
      expectedFirstTool: "open_binary",
      requiresEvidence: false,
      requiredAnswerTermGroups: [["unavailable", "could not", "provider"]],
      prompt: `Explain what the shipped native program at ${targets.native} does. Base the answer on artifact analysis, and clearly state any facts that remain unavailable.`,
    },
    {
      id: "asar",
      expectedFirstTool: "analyze_javascript_application",
      requiresEvidence: true,
      requiredAnswerTermGroups: [
        ["profileapi"],
        ["profile:read"],
        ["preload", "contextbridge"],
      ],
      prompt: `Explain how the desktop application at ${targets.javascript} exposes APIs to its renderer. Base the answer on the shipped application artifact, and state what remains unknown.`,
    },
    {
      id: "javascript-export-shape",
      expectedFirstTool: "analyze_javascript_application",
      requiresEvidence: true,
      requiredToolSubsequence: [
        "analyze_javascript_application",
        "analyze_javascript_application",
        "compare_javascript_export_shapes",
      ],
      requiredAnswerTermGroups: [
        ["/depth", "depth"],
        [
          "literal value `1`",
          "literal `1`",
          "depth: 1",
          '"depth": 1',
          "depth = 1",
        ],
        ["static", "inferred"],
        ["runtime", "replay"],
      ],
      prompt: `Without directly reading target files, compare the default export in parser.mjs between ${targets.javascriptShapeLeft} and ${targets.javascriptShapeRight}. Use REA to analyze each shipped artifact and then compare its exact static export return shapes. State the exact heading-shape change, cite produced Evidence, and distinguish static inference from runtime semantics.`,
    },
    {
      id: "managed",
      expectedFirstTool: "inspect_managed_artifact",
      requiresEvidence: true,
      requiredAnswerTermGroups: [["profile"], ["main", "entry point"]],
      prompt: `Explain the public managed types and entry point in ${targets.managed}. Use shipped-artifact evidence and distinguish unavailable behavior from observed metadata.`,
    },
    {
      id: "browser",
      expectedFirstTool: "list_browser_targets",
      requiresEvidence: false,
      requiredAnswerTermGroups: [
        ["unavailable", "could not", "connection", "endpoint"],
      ],
      prompt:
        "A user-owned page is already open at http://127.0.0.1:3000 through the approved local debugging endpoint http://127.0.0.1:9222. Inspect what is available without navigating or executing page code, and report any authority or availability limits.",
    },
  ];
  const requestedScenarioIds = new Set(
    (process.env.REA_AGENT_EVAL_SCENARIOS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  const scenarios =
    requestedScenarioIds.size === 0
      ? allScenarios
      : allScenarios.filter(({ id }) => requestedScenarioIds.has(id));
  if (
    requestedScenarioIds.size > 0 &&
    scenarios.length !== requestedScenarioIds.size
  )
    throw new Error(
      `Unknown or duplicate REA_AGENT_EVAL_SCENARIOS value: ${[...requestedScenarioIds].join(",")}`,
    );
  const results = [];
  for (const scenario of scenarios) {
    process.stderr.write(`Running Codex agent evaluation: ${scenario.id}\n`);
    const execution = await runCodex(scenario.prompt, fixtureRoot);
    const transcriptDirectory = process.env.REA_AGENT_EVAL_TRANSCRIPT_DIR;
    if (transcriptDirectory !== undefined) {
      const transcriptPath = resolve(
        transcriptDirectory,
        `${scenario.id}.jsonl`,
      );
      await mkdir(dirname(transcriptPath), { recursive: true });
      await writeFile(
        transcriptPath,
        `${execution.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
    }
    const metrics = evaluateCodexEvents(
      execution.events,
      scenario.expectedFirstTool,
      {
        requireEvidence: scenario.requiresEvidence,
        requiredAnswerTermGroups: scenario.requiredAnswerTermGroups,
        requiredToolSubsequence: scenario.requiredToolSubsequence,
        forbidInputValidationFailures: true,
      },
    );
    const result = {
      id: scenario.id,
      expectedFirstTool: scenario.expectedFirstTool,
      requiresEvidence: scenario.requiresEvidence,
      qualityCriteria: scenario.requiredAnswerTermGroups,
      requiredToolSubsequence: scenario.requiredToolSubsequence ?? [],
      exitCode: execution.exitCode,
      stderr: execution.stderr,
      ...metrics,
    };
    results.push(result);
    process.stderr.write(
      `${scenario.id}: first=${metrics.firstTool ?? "none"}, calls=${String(metrics.reaCalls.length)}, repeats=${String(metrics.repeatedCallCount)}, validation_failures=${String(metrics.inputValidationFailureCount)}, input_tokens=${String(metrics.inputTokens)}\n`,
    );
  }

  const summary = {
    schemaVersion: 1,
    codex,
    codexVersion,
    model: optionalModel ?? null,
    scenarios: results.map(({ finalMessage: _message, ...result }) => result),
    totals: {
      scenarios: results.length,
      naturalUse: results.filter(({ naturalUse }) => naturalUse).length,
      correctFirstTool: results.filter(
        ({ correctFirstTool }) => correctFirstTool,
      ).length,
      repeatedCallCount: results.reduce(
        (total, { repeatedCallCount }) => total + repeatedCallCount,
        0,
      ),
      inputValidationFailureCount: results.reduce(
        (total, { inputValidationFailureCount }) =>
          total + inputValidationFailureCount,
        0,
      ),
      requiredToolSubsequence: results.filter(
        ({ requiredToolSubsequenceMet }) => requiredToolSubsequenceMet,
      ).length,
      inputTokens: results.reduce(
        (total, { inputTokens }) => total + inputTokens,
        0,
      ),
      cachedInputTokens: results.reduce(
        (total, { cachedInputTokens }) => total + cachedInputTokens,
        0,
      ),
      completionQuality: results.filter(({ completionQuality }) =>
        Boolean(completionQuality),
      ).length,
      authorityHonesty: results.filter(({ authorityHonesty }) =>
        Boolean(authorityHonesty),
      ).length,
    },
  };
  const encoded = `${JSON.stringify(summary, null, 2)}\n`;
  process.stdout.write(encoded);
  const reportPath = process.env.REA_AGENT_EVAL_REPORT_PATH;
  if (reportPath !== undefined) {
    await mkdir(dirname(resolve(reportPath)), { recursive: true });
    await writeFile(resolve(reportPath), encoded);
  }

  const failed = results.filter(
    ({
      exitCode,
      naturalUse,
      correctFirstTool,
      repeatedCallCount,
      inputValidationFailureCount,
      requiredToolSubsequenceMet,
      inputTokens,
      completionQuality,
      authorityHonesty,
    }) =>
      exitCode !== 0 ||
      !naturalUse ||
      !correctFirstTool ||
      repeatedCallCount !== 0 ||
      inputValidationFailureCount !== 0 ||
      !requiredToolSubsequenceMet ||
      inputTokens <= 0 ||
      !completionQuality ||
      !authorityHonesty,
  );
  if (failed.length > 0)
    throw new Error(
      `Codex agent release evaluation failed: ${failed.map(({ id }) => id).join(", ")}`,
    );
} finally {
  if (process.env.REA_AGENT_EVAL_KEEP_FIXTURES !== "true")
    await rm(evaluationRoot, { recursive: true, force: true });
}

async function createTargets(root) {
  const javascript = join(root, "desktop-app");
  await mkdir(join(javascript, "renderer"), { recursive: true });
  await Promise.all([
    writeFile(
      join(javascript, "package.json"),
      `${JSON.stringify({ name: "desktop-fixture", version: "1.0.0", main: "main.js" }, null, 2)}\n`,
    ),
    writeFile(
      join(javascript, "main.js"),
      'const { BrowserWindow, ipcMain } = require("electron");\nnew BrowserWindow({ webPreferences: { preload: require("node:path").join(__dirname, "preload.js"), contextIsolation: true, sandbox: true } });\nipcMain.handle("profile:read", (_event, id) => ({ id }));\n',
    ),
    writeFile(
      join(javascript, "preload.js"),
      'const { contextBridge, ipcRenderer } = require("electron");\ncontextBridge.exposeInMainWorld("profileApi", { read: (id) => ipcRenderer.invoke("profile:read", id) });\n',
    ),
    writeFile(
      join(javascript, "renderer/app.js"),
      'globalThis.profileApi.read("fixture");\n',
    ),
  ]);
  const javascriptAsar = join(root, "desktop-app.asar");
  await createPackage(javascript, javascriptAsar);

  const javascriptShapeLeft = join(root, "parser-v1");
  const javascriptShapeRight = join(root, "parser-v2");
  await Promise.all([
    mkdir(javascriptShapeLeft, { recursive: true }),
    mkdir(javascriptShapeRight, { recursive: true }),
  ]);
  await Promise.all([
    cp(
      join(repositoryRoot, "tests/fixtures/replay/parser.mjs"),
      join(javascriptShapeLeft, "parser.mjs"),
    ),
    cp(
      join(repositoryRoot, "tests/fixtures/replay/parser-v2.mjs"),
      join(javascriptShapeRight, "parser.mjs"),
    ),
  ]);

  const managedProject = join(root, "managed-project");
  const managedOutput = join(root, "managed-output");
  await mkdir(managedProject, { recursive: true });
  await Promise.all([
    writeFile(
      join(managedProject, "AgentEval.csproj"),
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>\n',
    ),
    writeFile(
      join(managedProject, "Program.cs"),
      'namespace AgentEval; public sealed record Profile(string Id); public static class Program { public static void Main() => Console.WriteLine(new Profile("fixture")); }\n',
    ),
  ]);
  await runProcess(
    "dotnet",
    [
      "build",
      join(managedProject, "AgentEval.csproj"),
      "--configuration",
      "Release",
      "--output",
      managedOutput,
      "--nologo",
    ],
    root,
    120_000,
  );
  return {
    native: "/bin/true",
    javascript: javascriptAsar,
    javascriptShapeLeft,
    javascriptShapeRight,
    managed: join(managedOutput, "AgentEval.dll"),
  };
}

async function runCodex(prompt, investigationRoot) {
  const mcpEnvironment = [
    ["REA_INVESTIGATION_INPUT_ROOTS_JSON", JSON.stringify([investigationRoot])],
    ["REA_BROWSER_OBSERVE_ENABLED", "true"],
    [
      "REA_BROWSER_CDP_ENDPOINTS_JSON",
      JSON.stringify(["http://127.0.0.1:9222"]),
    ],
    [
      "REA_BROWSER_ALLOWED_ORIGINS_JSON",
      JSON.stringify(["http://127.0.0.1:3000"]),
    ],
  ];
  const mcpEnvironmentOverride = `mcp_servers.rea.env={${mcpEnvironment
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join(",")}}`;
  const arguments_ = [
    "exec",
    "--ignore-user-config",
    "--ignore-rules",
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
    "-c",
    `mcp_servers.rea.command=${JSON.stringify(process.execPath)}`,
    "-c",
    `mcp_servers.rea.args=${JSON.stringify([join(repositoryRoot, "scripts/rea.mjs"), "mcp"])}`,
    "-c",
    "mcp_servers.rea.startup_timeout_sec=30",
    "-c",
    mcpEnvironmentOverride,
    ...(optionalModel === undefined ? [] : ["--model", optionalModel]),
    prompt,
  ];
  const child = spawn(codex, arguments_, {
    cwd: evaluationRoot,
    env: {
      ...process.env,
      REA_INVESTIGATION_INPUT_ROOTS_JSON: JSON.stringify([investigationRoot]),
      REA_BROWSER_OBSERVE_ENABLED: "true",
      REA_BROWSER_CDP_ENDPOINTS_JSON: JSON.stringify(["http://127.0.0.1:9222"]),
      REA_BROWSER_ALLOWED_ORIGINS_JSON: JSON.stringify([
        "http://127.0.0.1:3000",
      ]),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const events = [];
  const stderr = [];
  const lines = createInterface({ input: child.stdout });
  const linesClosed = new Promise((resolveClose) =>
    lines.once("close", resolveClose),
  );
  lines.on("line", (line) => {
    try {
      events.push(JSON.parse(line));
    } catch {
      stderr.push(`non-json stdout: ${line}`);
    }
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.join("").length < 32_768) stderr.push(chunk.toString("utf8"));
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(`Codex evaluation timed out after ${String(timeoutMs)}ms`),
      );
    }, timeoutMs);
    child.once("error", (cause) => {
      clearTimeout(timeout);
      reject(cause);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolveExit(code ?? 1);
    });
  });
  await linesClosed;
  return { events, exitCode, stderr: stderr.join("").slice(0, 32_768) };
}

async function runProcess(command, arguments_, cwd, timeout) {
  const child = spawn(command, arguments_, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 32_768) stderr += chunk.toString("utf8");
  });
  const code = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, timeout);
    child.once("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.once("exit", (value) => {
      clearTimeout(timer);
      resolveExit(value ?? 1);
    });
  });
  if (code !== 0)
    throw new Error(`${command} failed with ${String(code)}: ${stderr}`);
}

async function readCommandVersion(command) {
  const child = spawn(command, ["--version"], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    if (stdout.length < 4096) stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 4096) stderr += chunk.toString("utf8");
  });
  const code = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} --version timed out`));
    }, 10_000);
    child.once("error", (cause) => {
      clearTimeout(timer);
      reject(cause);
    });
    child.once("exit", (value) => {
      clearTimeout(timer);
      resolveExit(value ?? 1);
    });
  });
  if (code !== 0)
    throw new Error(
      `${command} --version failed with ${String(code)}: ${stderr}`,
    );
  const version = stdout.trim();
  if (version.length === 0)
    throw new Error(`${command} --version returned empty output`);
  return version;
}
