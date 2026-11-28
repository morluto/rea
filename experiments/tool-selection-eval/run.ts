#!/usr/bin/env -S npx tsx
/**
 * Tool-selection eval for REA's MCP catalog.
 *
 *   npx tsx run.ts --audit                       # catalog size + similar-description pairs (no API key)
 *   npx tsx run.ts --fixtures fixtures.json      # run the eval (needs ANTHROPIC_API_KEY)
 *
 * Measures only the FIRST tool an agent picks for a task. Tools are never executed.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

// ---------- fixtures ----------

const TaskSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(10),
  /** Any tool in this list counts as a correct first call. */
  expected: z.array(z.string().min(1)).min(1),
  tags: z.array(z.string()).default([]),
});

const FixtureSchema = z
  .array(TaskSchema)
  .min(1)
  .superRefine((tasks, ctx) => {
    const seen = new Set<string>();
    tasks.forEach((t, i) => {
      if (seen.has(t.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate id "${t.id}"`,
          path: [i, "id"],
        });
      }
      seen.add(t.id);
    });
  });

type Task = z.infer<typeof TaskSchema>;

// ---------- CLI and Option Validation ----------

const { values: rawArgs } = parseArgs({
  options: {
    fixtures: { type: "string", default: "fixtures.example.json" },
    out: { type: "string", default: "report.json" },
    model: {
      type: "string",
      default: process.env.EVAL_MODEL ?? "claude-sonnet-5-5",
    },
    trials: { type: "string", default: "3" },
    concurrency: { type: "string", default: "4" },
    // "any" forces a tool call (pure selection); "auto" lets the model answer in text instead.
    choice: { type: "string", default: "any" },
    temperature: { type: "string", default: "0" },
    audit: { type: "boolean", default: false },
    // "subset" (default) = expected tools + nearest-neighbour distractors + filler; "full" = whole catalog.
    catalog: { type: "string", default: "subset" },
    "subset-size": { type: "string", default: "60" },
    // Allow requests whose tool definitions exceed ~150K estimated tokens.
    force: { type: "boolean", default: false },
  },
});

function parsePositiveInteger(value: string | undefined, name: string): number {
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(
      `Option --${name} must be a positive integer, got "${value ?? ""}".`,
    );
  }
  return num;
}

function parseTemperature(value: string | undefined): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(
      `Option --temperature must be a non-negative number, got "${value ?? ""}".`,
    );
  }
  return num;
}

function parseChoice(value: string | undefined): "any" | "auto" {
  if (value !== "any" && value !== "auto") {
    throw new Error(
      `Option --choice must be "any" or "auto", got "${value ?? ""}".`,
    );
  }
  return value;
}

function parseCatalogMode(value: string | undefined): "subset" | "full" {
  if (value !== "subset" && value !== "full") {
    throw new Error(
      `Option --catalog must be "subset" or "full", got "${value ?? ""}".`,
    );
  }
  return value;
}

const SYSTEM =
  "You are an agent with reverse-engineering tools. For the user's task, call the single tool " +
  "you would use FIRST. Do not explain.";

// ---------- MCP Command Resolution & Parsing ----------

/**
 * Parses command strings into arguments preserving quoted strings and spaces without shell invocation.
 */
function splitCommandLine(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i]!;
    if (char === "\\" && i + 1 < cmd.length) {
      const next = cmd[i + 1]!;
      if (next === '"' || next === "'" || next === "\\") {
        current += next;
        i++;
        continue;
      }
    }
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Resolves the locally installed rea-agents entry point from dependencies to avoid catalog drift.
 */
function defaultMcpCommand(): { command: string; args: string[] } {
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve("rea-agents/package.json");
    const scriptPath = join(dirname(pkgPath), "scripts", "rea.mjs");
    if (existsSync(scriptPath)) {
      return { command: process.execPath, args: [scriptPath, "mcp"] };
    }
  } catch {
    // Fall back to checking common relative paths
  }

  const candidateRelativePaths = [
    join(process.cwd(), "node_modules", "rea-agents", "scripts", "rea.mjs"),
    join(process.cwd(), "scripts", "rea.mjs"),
    join(process.cwd(), "..", "..", "scripts", "rea.mjs"),
  ];
  for (const candidate of candidateRelativePaths) {
    if (existsSync(candidate)) {
      return { command: process.execPath, args: [candidate, "mcp"] };
    }
  }

  return { command: "npx", args: ["rea-agents", "mcp"] };
}

/**
 * Accepts executable and arguments as a JSON array or a quote-aware command line string.
 */
function parseMcpCommand(raw?: string): { command: string; args: string[] } {
  if (!raw || raw.trim().length === 0) {
    return defaultMcpCommand();
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every((x) => typeof x === "string")
      ) {
        const [command, ...args] = parsed as string[];
        return { command: command!, args };
      }
    } catch {
      // Fall through to command line tokenization
    }
  }
  const tokens = splitCommandLine(trimmed);
  if (tokens.length === 0) {
    throw new Error(
      "REA_MCP_CMD was provided but contained no executable command.",
    );
  }
  const [command, ...args] = tokens;
  return { command: command!, args };
}

// ---------- catalog ----------

type McpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

async function loadCatalog(): Promise<McpTool[]> {
  const { command, args: cmdArgs } = parseMcpCommand(process.env.REA_MCP_CMD);
  const client = new Client({ name: "rea-tool-eval", version: "0.1.0" });
  await client.connect(new StdioClientTransport({ command, args: cmdArgs }));
  try {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools({ cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    await client.close();
  }
}

function catalogStats(tools: McpTool[]) {
  const rows = tools.map((t) => ({
    name: t.name,
    descChars: t.description?.length ?? 0,
    schemaChars: JSON.stringify(t.inputSchema).length,
  }));
  const totalChars = rows.reduce((s, r) => s + r.descChars + r.schemaChars, 0);
  // ~4 chars/token is a rough heuristic, not a tokenizer.
  return {
    toolCount: rows.length,
    totalChars,
    approxTokens: Math.round(totalChars / 4),
    rows,
  };
}

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );

/** Cheap heuristic: word-set Jaccard on descriptions. Surfaces candidates, not verdicts. */
function similarPairs(tools: McpTool[], top = 10) {
  const sets = tools.map((t) => words(t.description ?? ""));
  const pairs: { a: string; b: string; jaccard: number }[] = [];
  for (let i = 0; i < tools.length; i++) {
    for (let j = i + 1; j < tools.length; j++) {
      const inter = [...sets[i]!].filter((w) => sets[j]!.has(w)).length;
      const union = sets[i]!.size + sets[j]!.size - inter;
      if (union > 0)
        pairs.push({
          a: tools[i]!.name,
          b: tools[j]!.name,
          jaccard: inter / union,
        });
    }
  }
  return pairs.sort((x, y) => y.jaccard - x.jaccard).slice(0, top);
}

const fnv = (s: string) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};

/** Nearest tools by description similarity: the distractors most likely to cause a wrong pick. */
function neighbours(name: string, tools: McpTool[], k: number): string[] {
  const self = tools.find((t) => t.name === name);
  if (!self) return [];
  const a = words(self.description ?? "");
  return tools
    .filter((t) => t.name !== name)
    .map((t) => {
      const b = words(t.description ?? "");
      const inter = [...a].filter((w) => b.has(w)).length;
      return { name: t.name, score: inter / (a.size + b.size - inter || 1) };
    })
    .sort((x, y) => y.score - x.score)
    .slice(0, k)
    .map((x) => x.name);
}

/** Deterministic (no RNG) so runs are comparable across machines and over time. */
function selectCatalog(
  all: McpTool[],
  tasks: Task[],
  catalogMode: "subset" | "full",
  targetSubsetSize: number,
): McpTool[] {
  if (catalogMode === "full") return all;
  const chosen = new Set(tasks.flatMap((t) => t.expected));
  for (const name of [...chosen])
    neighbours(name, all, 4).forEach((n) => chosen.add(n));
  const filler = all
    .map((t) => t.name)
    .filter((n) => !chosen.has(n))
    .sort((a, b) => fnv(a) - fnv(b));
  for (const n of filler) {
    if (chosen.size >= targetSubsetSize) break;
    chosen.add(n);
  }
  return all.filter((t) => chosen.has(t.name));
}

// ---------- eval ----------

function toAnthropicTools(tools: McpTool[]): Anthropic.Tool[] {
  const mapped: Anthropic.Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
  // Cache the (large) tool block across requests to cut cost and latency.
  const last = mapped.length - 1;
  if (last >= 0) {
    mapped[last] = { ...mapped[last]!, cache_control: { type: "ephemeral" } };
  }
  return mapped;
}

async function runTrial(
  client: Anthropic,
  tools: Anthropic.Tool[],
  task: Task,
  options: {
    model: string;
    temperature: number;
    choice: "any" | "auto";
  },
): Promise<string> {
  const res = await client.messages.create({
    model: options.model,
    max_tokens: 512,
    temperature: options.temperature,
    system: SYSTEM,
    tools,
    tool_choice: options.choice === "auto" ? { type: "auto" } : { type: "any" },
    messages: [{ role: "user", content: task.prompt }],
  });
  const use = res.content.find((b) => b.type === "tool_use");
  return use?.type === "tool_use" ? use.name : "<none>";
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: n }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift())
        await fn(item);
    }),
  );
}

function stableJsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface TaskResult {
  id: string;
  prompt: string;
  expected: string[];
  tags: string[];
  picks: string[];
  passRate: number;
  status: "completed" | "failed";
  error?: string;
}

interface EvaluationReport {
  status: "completed" | "partial";
  date: string;
  settings: {
    model: string;
    choice: "any" | "auto";
    trials: number;
    concurrency: number;
    temperature: number;
    catalogMode: "subset" | "full";
    subsetSize: number;
    fixturesPath: string;
    force: boolean;
  };
  hashes: {
    fixturesSha256: string;
    toolsSha256: string;
  };
  catalog: {
    mode: "subset" | "full";
    liveToolCount: number;
    presentedToolCount: number;
    approxTokens: number;
    presentedToolNames: string[];
    presentedTools: {
      name: string;
      description: string;
      inputSchema: unknown;
    }[];
  };
  accuracy: number;
  results: TaskResult[];
  confusions: Record<string, number>;
  failures: { id: string; error: string; completedTrials: number }[];
}

async function writeReport(
  outPath: string,
  report: EvaluationReport,
): Promise<void> {
  await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
}

async function main() {
  // Validate options before connecting or running any requests
  const trials = parsePositiveInteger(rawArgs.trials, "trials");
  const concurrency = parsePositiveInteger(rawArgs.concurrency, "concurrency");
  const subsetSize = parsePositiveInteger(
    rawArgs["subset-size"],
    "subset-size",
  );
  const temperature = parseTemperature(rawArgs.temperature);
  const choice = parseChoice(rawArgs.choice);
  const catalogMode = parseCatalogMode(rawArgs.catalog);
  const fixturesPath = rawArgs.fixtures!;
  const outPath = rawArgs.out!;
  const model = rawArgs.model!;
  const force = rawArgs.force;

  const catalog = await loadCatalog();
  const stats = catalogStats(catalog);

  if (rawArgs.audit) {
    console.log(
      `tools: ${stats.toolCount}  chars: ${stats.totalChars}  ~tokens: ${stats.approxTokens}`,
    );
    console.log("\nlargest definitions:");
    console.table(
      [...stats.rows]
        .sort(
          (a, b) => b.schemaChars + b.descChars - a.schemaChars - a.descChars,
        )
        .slice(0, 15),
    );
    console.log("\nmost similar descriptions (candidates only):");
    console.table(similarPairs(catalog));
    console.log(
      "\nall tool names:\n" +
        catalog
          .map((t) => t.name)
          .sort()
          .join("\n"),
    );
    return;
  }

  const tasks = FixtureSchema.parse(
    JSON.parse(await readFile(fixturesPath, "utf8")),
  );
  const known = new Set(catalog.map((t) => t.name));
  const unknown = tasks.flatMap((t) =>
    t.expected.filter((e) => !known.has(e)).map((e) => `${t.id}: ${e}`),
  );
  if (unknown.length) {
    throw new Error(
      `Fixtures reference tools missing from the live catalog:\n  ${unknown.join("\n  ")}`,
    );
  }

  const evalCatalog = selectCatalog(catalog, tasks, catalogMode, subsetSize);
  const evalStats = catalogStats(evalCatalog);
  console.log(
    `catalog mode: ${catalogMode} (${evalStats.toolCount}/${stats.toolCount} tools, ~${evalStats.approxTokens} tokens)`,
  );
  if (evalStats.approxTokens > 150_000 && !force) {
    throw new Error(
      `Tool definitions are ~${evalStats.approxTokens} tokens, likely beyond the model context. ` +
        `Use --catalog subset (default) or pass --force.`,
    );
  }

  const presentedToolsSnapshot = evalCatalog
    .map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const toolsSha256 = stableJsonHash(presentedToolsSnapshot);

  const fixturesSnapshot = [...tasks].sort((a, b) => a.id.localeCompare(b.id));
  const fixturesSha256 = stableJsonHash(fixturesSnapshot);

  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY; SDK retries 429/5xx by default
  const tools = toAnthropicTools(evalCatalog);
  const results: TaskResult[] = [];
  const failures: { id: string; error: string; completedTrials: number }[] = [];

  const buildReport = (status: "completed" | "partial"): EvaluationReport => {
    const confusion = new Map<string, number>();
    for (const r of results) {
      for (const p of r.picks) {
        if (!r.expected.includes(p)) {
          const key = `${r.expected[0] ?? "unknown"} -> ${p}`;
          confusion.set(key, (confusion.get(key) ?? 0) + 1);
        }
      }
    }
    const completedResults = results.filter(
      (r) => r.status === "completed" || r.picks.length > 0,
    );
    const accuracy =
      completedResults.length > 0
        ? completedResults.reduce((s, r) => s + r.passRate, 0) /
          completedResults.length
        : 0;

    return {
      status,
      date: new Date().toISOString(),
      settings: {
        model,
        choice,
        trials,
        concurrency,
        temperature,
        catalogMode,
        subsetSize,
        fixturesPath,
        force,
      },
      hashes: {
        fixturesSha256,
        toolsSha256,
      },
      catalog: {
        mode: catalogMode,
        liveToolCount: stats.toolCount,
        presentedToolCount: evalStats.toolCount,
        approxTokens: evalStats.approxTokens,
        presentedToolNames: presentedToolsSnapshot.map((t) => t.name),
        presentedTools: presentedToolsSnapshot,
      },
      accuracy,
      results: [...results].sort((a, b) => a.id.localeCompare(b.id)),
      confusions: Object.fromEntries(confusion),
      failures,
    };
  };

  try {
    await pool(tasks, concurrency, async (task) => {
      const picks: string[] = [];
      let taskError: string | undefined;

      for (let i = 0; i < trials; i++) {
        try {
          picks.push(
            await runTrial(anthropic, tools, task, {
              model,
              temperature,
              choice,
            }),
          );
        } catch (err) {
          taskError = err instanceof Error ? err.message : String(err);
          break;
        }
      }

      const passRate =
        picks.length > 0
          ? picks.filter((p) => task.expected.includes(p)).length / picks.length
          : 0;

      const result: TaskResult = {
        id: task.id,
        prompt: task.prompt,
        expected: task.expected,
        tags: task.tags,
        picks,
        passRate,
        status: taskError ? "failed" : "completed",
        ...(taskError ? { error: taskError } : {}),
      };
      results.push(result);

      if (taskError) {
        failures.push({
          id: task.id,
          error: taskError,
          completedTrials: picks.length,
        });
        console.error(`FAIL  ${task.id}  (error: ${taskError})`);
      } else {
        console.log(
          `${passRate === 1 ? "PASS" : passRate === 0 ? "FAIL" : "FLAKY"}  ${task.id}  -> ${picks.join(", ")}`,
        );
      }

      // Persist completed trials incrementally so progress is preserved
      await writeReport(outPath, buildReport("partial"));
    });
  } catch (err) {
    // If pool or runner fails unexpectedly, persist the partial report before exiting
    await writeReport(outPath, buildReport("partial"));
    throw err;
  }

  const finalStatus = failures.length > 0 ? "partial" : "completed";
  const finalReport = buildReport(finalStatus);
  await writeReport(outPath, finalReport);

  console.log(
    `\naccuracy: ${(finalReport.accuracy * 100).toFixed(1)}% over ${results.length}/${tasks.length} tasks (${failures.length} failed)`,
  );
  if (Object.keys(finalReport.confusions).length > 0) {
    console.log("most common confusions:");
    console.table(
      Object.entries(finalReport.confusions)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([pair, count]) => ({ pair, count })),
    );
  }
  console.log(`report written to ${outPath}`);

  if (failures.length > 0) {
    throw new Error(
      `Evaluation ended with ${failures.length} failed task(s). Partial report written to ${outPath}.`,
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
