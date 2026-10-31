import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chat, parseCommand, runTeardown } from "./agent.ts";
import { loadConfig, type Config } from "./config.ts";
import { selectBackend, type ModelBackend } from "./models.ts";
import { Vault } from "./vault.ts";

interface Job {
  readonly id: string;
  steps: string[];
  done: boolean;
  reply: string | null;
  reportId: string | null;
  error: string | null;
}

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > limit) throw new Error("Request too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createJarvisServer(
  cfg: Config,
  model: ModelBackend | null,
  deps: { runTeardown?: typeof runTeardown } = {},
) {
  const vault = new Vault(cfg.vaultDir);
  const teardown = deps.runTeardown ?? runTeardown;
  const jobs = new Map<string, Job>();
  let busy = false;

  const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);

  async function handleCommand(text: string): Promise<Job> {
    const job: Job = { id: String(Date.now()), steps: [], done: false, reply: null, reportId: null, error: null };
    jobs.set(job.id, job);
    void (async () => {
      try {
        const cmd = parseCommand(text);
        if (cmd.kind === "teardown") {
          job.steps.push(`Plan: teardown ${cmd.target}${cmd.clone ? " + clone + test" : ""}`);
          const r = await teardown(cmd, cfg, vault, model, (s) => job.steps.push(s));
          job.reportId = r.entry.id;
          job.reply = `Teardown complete: ${r.entry.id}`;
        } else {
          job.reply = await chat(text, vault, model);
        }
      } catch (e) {
        job.error = e instanceof Error ? e.message : String(e);
      } finally {
        job.done = true;
        busy = false;
      }
    })();
    return job;
  }

  return createServer(async (req, res) => {
    // Loopback-only service: reject foreign Host/Origin to block DNS rebinding and cross-site POSTs.
    if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 403, { error: "forbidden host" });
    const origin = req.headers.origin;
    if (req.method === "POST" && origin && !allowedHosts.has(new URL(origin).host)) {
      return send(res, 403, { error: "forbidden origin" });
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/status") {
        return send(res, 200, { model: model?.name ?? null, busy });
      }
      if (req.method === "GET" && url.pathname === "/api/teardowns") {
        return send(res, 200, await vault.list());
      }
      const report = /^\/api\/teardowns\/([^/]+)\/report$/.exec(url.pathname);
      if (req.method === "GET" && report) {
        const md = await vault.readReport(decodeURIComponent(report[1]!));
        return md === null ? send(res, 404, { error: "not found" }) : send(res, 200, md, "text/markdown; charset=utf-8");
      }
      const jobMatch = /^\/api\/jobs\/(\d+)$/.exec(url.pathname);
      if (req.method === "GET" && jobMatch) {
        const job = jobs.get(jobMatch[1]!);
        return job ? send(res, 200, job) : send(res, 404, { error: "not found" });
      }
      if (req.method === "POST" && url.pathname === "/api/command") {
        if (busy) return send(res, 409, { error: "Jarvis is busy with another job." });
        const { text } = JSON.parse(await readBody(req)) as { text?: string };
        if (!text?.trim()) return send(res, 400, { error: "text required" });
        busy = true;
        const job = await handleCommand(text);
        return send(res, 202, { jobId: job.id });
      }
      if (req.method === "GET") {
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const resolved = path.resolve(publicDir, file);
        if (!resolved.startsWith(publicDir + path.sep)) return send(res, 404, "not found", "text/plain");
        const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
        return send(res, 200, await readFile(resolved), types[path.extname(resolved)] ?? "text/plain");
      }
      return send(res, 404, { error: "not found" });
    } catch (e) {
      return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.loadEnvFile(path.join(path.dirname(publicDir), ".env"));
  } catch {
    // .env is optional; real environment variables still apply
  }
  const cfg = loadConfig();
  const model = selectBackend();
  createJarvisServer(cfg, model).listen(cfg.port, "127.0.0.1", () => {
    console.log(`Jarvis running at http://127.0.0.1:${cfg.port}`);
    console.log(`Model backend: ${model?.name ?? "none (set ANTHROPIC_API_KEY / OPENAI_API_KEY / GITHUB_TOKEN)"}`);
    console.log(`Vault: ${cfg.vaultDir}`);
  });
}
