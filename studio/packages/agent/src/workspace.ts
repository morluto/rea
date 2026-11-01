import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { tool, type ToolSet } from "ai";
import { z } from "zod";

import {
  approve,
  clip,
  errorMessage,
  MODEL_RESULT_CHARS,
  preview,
  type ToolContext,
} from "./context.js";

/** Job folders. Only the writable ones accept agent writes. */
export const WORKSPACE_DIRS = [
  "input",
  "evidence",
  "notes",
  "spec",
  "output",
  "logs",
] as const;
const WRITABLE_DIRS = new Set(["notes", "spec", "output"]);
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  ".gradle",
]);

/** Environment for agent commands: toolchains yes, Studio secrets never. */
const COMMAND_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SHELL",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "GOPATH",
  "GOCACHE",
  "GOMODCACHE",
  "JAVA_HOME",
  "DOTNET_ROOT",
  "ANDROID_HOME",
];

interface BackgroundProcess {
  readonly child: ChildProcess;
  readonly command: string;
  output: string;
  exitCode: number | null;
}

export class Workspace {
  readonly root: string;
  readonly #processes = new Map<string, BackgroundProcess>();

  constructor(root: string) {
    this.root = resolve(root);
  }

  async prepare(): Promise<void> {
    for (const dir of WORKSPACE_DIRS) {
      // These directories are runtime job data, not application build assets.
      await mkdir(join(/* turbopackIgnore: true */ this.root, dir), {
        recursive: true,
      });
    }
  }

  path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  /** Resolve a model-supplied path and refuse anything outside the job. */
  resolveInside(path: string): string {
    const absolute = isAbsolute(path)
      ? resolve(path)
      : resolve(this.root, path);
    const rel = relative(this.root, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Path ${path} is outside the job workspace.`);
    }
    return absolute;
  }

  resolveWritable(path: string): string {
    const absolute = this.resolveInside(path);
    const top = relative(this.root, absolute).split(sep)[0] ?? "";
    if (!WRITABLE_DIRS.has(top)) {
      throw new Error(
        `Writes are limited to ${[...WRITABLE_DIRS].join(", ")}/; ${path} is not.`,
      );
    }
    return absolute;
  }

  relativePath(absolute: string): string {
    return relative(this.root, absolute) || ".";
  }

  async list(path: string, depth: number, limit = 400): Promise<string[]> {
    const start = this.resolveInside(path);
    const lines: string[] = [];
    const walk = async (dir: string, level: number): Promise<void> => {
      if (lines.length >= limit) return;
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (lines.length >= limit) return;
        const full = join(dir, entry.name);
        const rel = this.relativePath(full);
        if (entry.isDirectory()) {
          lines.push(`${rel}/`);
          if (level < depth && !SKIPPED_DIRS.has(entry.name)) {
            await walk(full, level + 1);
          }
        } else {
          const size = (await stat(full)).size;
          lines.push(`${rel} (${size} bytes)`);
        }
      }
    };
    await walk(start, 1);
    if (lines.length >= limit)
      lines.push(`… listing stopped at ${limit} entries`);
    return lines;
  }

  async grep(pattern: string, path: string, limit = 200): Promise<string[]> {
    const regex = new RegExp(pattern, "u");
    const start = this.resolveInside(path);
    const matches: string[] = [];
    let scanned = 0;
    const visit = async (target: string): Promise<void> => {
      if (matches.length >= limit || scanned > 5_000) return;
      const info = await stat(target);
      if (info.isDirectory()) {
        for (const entry of await readdir(target, { withFileTypes: true })) {
          if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
          await visit(join(target, entry.name));
        }
        return;
      }
      if (info.size > 2_000_000) return;
      scanned += 1;
      const content = await readFile(target, "utf8").catch(() => "");
      if (content.includes("\u0000")) return;
      const lines = content.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (regex.test(line)) {
          matches.push(
            `${this.relativePath(target)}:${index + 1}: ${line.slice(0, 300)}`,
          );
          if (matches.length >= limit) return;
        }
      }
    };
    await visit(start);
    return matches;
  }

  /** Run a shell command in the workspace with a timeout and clipped output. */
  async run(
    command: string,
    cwd: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
    const child = this.#spawn(command, cwd);
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 400_000) output = output.slice(-200_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = () => killTree(child);
    signal.addEventListener("abort", onAbort, { once: true });
    const exitCode = await new Promise<number | null>((done) => {
      child.once("close", (code) => done(code));
      child.once("error", (cause) => {
        output += `\n${errorMessage(cause)}`;
        done(null);
      });
    });
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    return { exitCode, output, timedOut };
  }

  startBackground(command: string, cwd: string): string {
    const id = `proc_${this.#processes.size + 1}`;
    const child = this.#spawn(command, cwd);
    const entry: BackgroundProcess = {
      child,
      command,
      output: "",
      exitCode: null,
    };
    const append = (chunk: Buffer) => {
      entry.output = (entry.output + chunk.toString("utf8")).slice(-50_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("close", (code) => {
      entry.exitCode = code;
    });
    this.#processes.set(id, entry);
    return id;
  }

  background(id: string): BackgroundProcess | undefined {
    return this.#processes.get(id);
  }

  stopBackground(id: string): boolean {
    const entry = this.#processes.get(id);
    if (!entry) return false;
    killTree(entry.child);
    return true;
  }

  stopAll(): void {
    for (const entry of this.#processes.values()) killTree(entry.child);
  }

  #spawn(command: string, cwd: string): ChildProcess {
    const env: Record<string, string> = {};
    for (const name of COMMAND_ENV) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    return spawn("/bin/sh", ["-c", command], {
      cwd: this.resolveInside(cwd),
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

const killTree = (child: ChildProcess): void => {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
  setTimeout(() => {
    if (child.exitCode !== null || child.pid === undefined) return;
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }, 3_000).unref();
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        done();
      },
      { once: true },
    );
  });

/** Wrap a workspace tool body with event emission and error capture. */
const instrumented = async (
  ctx: ToolContext,
  name: string,
  toolCallId: string,
  input: unknown,
  body: () => Promise<string>,
): Promise<string> => {
  ctx.emit({
    type: "tool-call",
    phase: ctx.phase,
    toolCallId,
    tool: name,
    source: "workspace",
    input: preview(ctx.redactor.redact(JSON.stringify(input))),
  });
  try {
    const result = ctx.redactor.redact(await body());
    ctx.emit({
      type: "tool-result",
      phase: ctx.phase,
      toolCallId,
      tool: name,
      ok: true,
      preview: preview(result),
    });
    return clip(result, MODEL_RESULT_CHARS);
  } catch (cause: unknown) {
    const message = ctx.redactor.redact(errorMessage(cause));
    ctx.emit({
      type: "tool-result",
      phase: ctx.phase,
      toolCallId,
      tool: name,
      ok: false,
      preview: preview(message),
    });
    return `Error: ${message}`;
  }
};

export interface WorkspaceToolOptions {
  readonly write: boolean;
  readonly commands: boolean;
}

/** File and command tools confined to one job workspace. */
export const workspaceTools = (
  ws: Workspace,
  ctx: ToolContext,
  options: WorkspaceToolOptions,
): ToolSet => {
  const tools: ToolSet = {
    list_files: tool({
      description:
        "List files under a workspace path (relative to the job root). Folders: input/ (target artifact), evidence/ (saved REA results), notes/, spec/, output/ (the rebuild).",
      inputSchema: z.object({
        path: z.string().default("."),
        depth: z.number().int().min(1).max(6).default(2),
      }),
      execute: (input, { toolCallId }) =>
        instrumented(ctx, "list_files", toolCallId, input, async () =>
          (await ws.list(input.path, input.depth)).join("\n"),
        ),
    }),
    read_file: tool({
      description:
        "Read a text file from the workspace. Use offset/limit (in lines) to page through large files such as saved REA evidence.",
      inputSchema: z.object({
        path: z.string(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(4_000).default(800),
      }),
      execute: (input, { toolCallId }) =>
        instrumented(ctx, "read_file", toolCallId, input, async () => {
          const content = await readFile(ws.resolveInside(input.path), "utf8");
          const lines = content.split("\n");
          const slice = lines.slice(input.offset, input.offset + input.limit);
          const more = input.offset + input.limit < lines.length;
          return `${slice.join("\n")}${more ? `\n… [${lines.length - input.offset - input.limit} more lines; continue with offset ${input.offset + input.limit}]` : ""}`;
        }),
    }),
    grep: tool({
      description:
        "Search workspace files for a regular expression and return file:line matches.",
      inputSchema: z.object({
        pattern: z.string().min(1),
        path: z.string().default("."),
      }),
      execute: (input, { toolCallId }) =>
        instrumented(ctx, "grep", toolCallId, input, async () => {
          const matches = await ws.grep(input.pattern, input.path);
          return matches.length ? matches.join("\n") : "No matches.";
        }),
    }),
  };

  if (options.write) {
    tools.write_file = tool({
      description:
        "Create or overwrite a text file under notes/, spec/ or output/.",
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      execute: (input, { toolCallId }) =>
        instrumented(
          ctx,
          "write_file",
          toolCallId,
          { path: input.path, bytes: input.content.length },
          async () => {
            const target = ws.resolveWritable(input.path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, input.content, "utf8");
            ctx.emit({
              type: "file",
              path: ws.relativePath(target),
              action: "write",
            });
            return `Wrote ${ws.relativePath(target)} (${input.content.length} characters).`;
          },
        ),
    });
    tools.edit_file = tool({
      description:
        "Replace an exact string in a file under notes/, spec/ or output/. old_string must match exactly once unless replace_all is true.",
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().default(false),
      }),
      execute: (input, { toolCallId }) =>
        instrumented(
          ctx,
          "edit_file",
          toolCallId,
          { path: input.path },
          async () => {
            const target = ws.resolveWritable(input.path);
            const content = await readFile(target, "utf8");
            const count = content.split(input.old_string).length - 1;
            if (count === 0) throw new Error("old_string was not found.");
            if (count > 1 && !input.replace_all) {
              throw new Error(
                `old_string matches ${count} times; add context or set replace_all.`,
              );
            }
            const updated = input.replace_all
              ? content.split(input.old_string).join(input.new_string)
              : content.replace(input.old_string, () => input.new_string);
            await writeFile(target, updated, "utf8");
            ctx.emit({
              type: "file",
              path: ws.relativePath(target),
              action: "edit",
            });
            return `Edited ${ws.relativePath(target)} (${input.replace_all ? count : 1} replacement).`;
          },
        ),
    });
  }

  if (options.commands) {
    tools.run_command = tool({
      description:
        "Run a shell command (build, test, format, package install) inside the workspace, by default in output/. Returns exit code and the tail of the output. Use start_process for servers.",
      inputSchema: z.object({
        command: z.string().min(1),
        cwd: z.string().default("output"),
        timeout_seconds: z.number().int().min(1).max(1_800).default(300),
      }),
      execute: (input, { toolCallId }) =>
        instrumented(ctx, "run_command", toolCallId, input, async () => {
          const decision = await approve(
            ctx,
            "command",
            `Run: ${input.command}`,
            `Working directory: ${input.cwd}`,
          );
          if (!decision.approved) {
            return `The user declined this command.${decision.note ? ` Note: ${decision.note}` : ""}`;
          }
          const result = await ws.run(
            input.command,
            input.cwd,
            input.timeout_seconds * 1_000,
            ctx.signal,
          );
          const tail =
            result.output.length > 12_000
              ? `… [earlier output omitted]\n${result.output.slice(-12_000)}`
              : result.output;
          return `exit code: ${result.exitCode ?? "none"}${result.timedOut ? " (timed out)" : ""}\n${tail}`;
        }),
    });
    tools.start_process = tool({
      description:
        "Start a long-running process (for example the rebuilt server) in the background and return its id and early output.",
      inputSchema: z.object({
        command: z.string().min(1),
        cwd: z.string().default("output"),
        wait_seconds: z.number().int().min(0).max(120).default(5),
      }),
      execute: (input, { toolCallId }) =>
        instrumented(ctx, "start_process", toolCallId, input, async () => {
          const decision = await approve(
            ctx,
            "command",
            `Start process: ${input.command}`,
            `Working directory: ${input.cwd}`,
          );
          if (!decision.approved) return "The user declined this process.";
          const id = ws.startBackground(input.command, input.cwd);
          await sleep(input.wait_seconds * 1_000, ctx.signal);
          const entry = ws.background(id);
          return `id: ${id}\nrunning: ${entry?.exitCode === null}\nexit code: ${entry?.exitCode ?? "none"}\noutput so far:\n${entry?.output.slice(-6_000) ?? ""}`;
        }),
    });
    tools.process_output = tool({
      description: "Read recent output of a background process.",
      inputSchema: z.object({ id: z.string() }),
      execute: (input, { toolCallId }) =>
        instrumented(ctx, "process_output", toolCallId, input, async () => {
          const entry = ws.background(input.id);
          if (!entry) throw new Error(`No process ${input.id}.`);
          return `running: ${entry.exitCode === null}\nexit code: ${entry.exitCode ?? "none"}\n${entry.output.slice(-8_000)}`;
        }),
    });
    tools.stop_process = tool({
      description: "Stop a background process started with start_process.",
      inputSchema: z.object({ id: z.string() }),
      execute: (input, { toolCallId }) =>
        instrumented(ctx, "stop_process", toolCallId, input, async () =>
          ws.stopBackground(input.id)
            ? `Stopped ${input.id}.`
            : `No process ${input.id}.`,
        ),
    });
  }

  return tools;
};
