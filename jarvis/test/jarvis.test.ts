import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractHtml, parseCommand, runTeardown } from "../src/agent.ts";
import { findChrome } from "../src/browser.ts";
import { loadConfig } from "../src/config.ts";
import { selectBackend } from "../src/models.ts";
import { createJarvisServer } from "../src/server.ts";
import { Vault, slugFor } from "../src/vault.ts";

test("parseCommand detects teardown and clone intent", () => {
  assert.deepEqual(parseCommand("reverse engineer https://example.com."), {
    kind: "teardown",
    target: "https://example.com",
    clone: false,
  });
  assert.equal(parseCommand("Reverse engineer https://a.dev/x and clone it").clone, true);
  assert.equal(parseCommand("hello there").kind, "chat");
  assert.equal(parseCommand("https://example.com").kind, "chat");
});

test("extractHtml handles fenced and bare html", () => {
  assert.equal(extractHtml("x ```html\n<html>a</html>\n``` y"), "<html>a</html>");
  assert.equal(extractHtml("<!doctype html><p>x"), "<!doctype html><p>x");
  assert.equal(extractHtml("nope"), null);
});

test("selectBackend uses env keys only and honors forcing", () => {
  assert.equal(selectBackend({}), null);
  assert.match(selectBackend({ OPENAI_API_KEY: "k" })!.name, /^openai:/);
  assert.match(selectBackend({ ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" })!.name, /^anthropic:/);
  assert.match(selectBackend({ GITHUB_TOKEN: "k" })!.name, /^github-models:/);
  assert.match(
    selectBackend({ ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", JARVIS_MODEL_BACKEND: "openai" })!.name,
    /^openai:/,
  );
});

test("backend sends bearer key and parses reply", async () => {
  let seen: { url: string; auth: string | null } | null = null;
  const fake = (async (url: string, init: RequestInit) => {
    seen = { url, auth: new Headers(init.headers).get("authorization") };
    return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }));
  }) as unknown as typeof fetch;
  const b = selectBackend({ OPENAI_API_KEY: "secret" }, fake)!;
  assert.equal(await b.complete([{ role: "user", content: "x" }]), "hi");
  assert.equal(seen!.auth, "Bearer secret");
});

test("vault records index and memory; report ids cannot escape", async () => {
  const v = new Vault(mkdtempSync(path.join(os.tmpdir(), "jv-")));
  const id = slugFor("https://Example.com/a b");
  assert.match(id, /^example-com-a-20b-\d{8}T\d{6}$/);
  const dir = await v.create(id);
  await import("node:fs/promises").then((fs) => fs.writeFile(path.join(dir, "report.md"), "# r"));
  await v.record({ id, target: "https://example.com", createdAt: "t", dir, summary: "s", cloneStatus: "none" });
  assert.equal((await v.list()).length, 1);
  assert.match(await v.memory(), /example\.com/);
  assert.equal(await v.readReport(id), "# r");
  assert.equal(await v.readReport("..\\..\\x"), null);
});

test("server runs a command job, rejects foreign hosts", async () => {
  const cfg = { ...loadConfig({}), port: 0, vaultDir: mkdtempSync(path.join(os.tmpdir(), "jv-")) };
  const stub = (async (_c: unknown, _cfg: unknown, _v: unknown, _m: unknown, emit: (s: string) => void) => {
    emit("stub step");
    return { entry: { id: "stub" }, report: "" };
  }) as unknown as typeof runTeardown;
  const server = createJarvisServer(cfg, null, { runTeardown: stub });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  // the allowed-host set is keyed on cfg.port, so use that port via Host header
  const hdr = { host: `127.0.0.1:${cfg.port}` };
  const call = (p: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { ...hdr, "content-type": "application/json" } });
  // Node's fetch forbids overriding Host; use http.request instead.
  const { request } = await import("node:http");
  const raw = (p: string, host: string, body?: string) =>
    new Promise<{ status: number; text: string }>((resolve) => {
      const req = request({ port, host: "127.0.0.1", path: p, method: body ? "POST" : "GET", headers: { host, "content-type": "application/json" } }, (res) => {
        let t = "";
        res.on("data", (d) => (t += d));
        res.on("end", () => resolve({ status: res.statusCode!, text: t }));
      });
      req.end(body);
    });
  void call;
  assert.equal((await raw("/api/status", "evil.com")).status, 403);
  const ok = `127.0.0.1:${cfg.port}`;
  assert.equal((await raw("/api/status", ok)).status, 200);
  const started = await raw("/api/command", ok, JSON.stringify({ text: "reverse engineer https://example.com" }));
  assert.equal(started.status, 202);
  const { jobId } = JSON.parse(started.text) as { jobId: string };
  let job: { done: boolean; steps: string[]; reportId: string | null } = { done: false, steps: [], reportId: null };
  for (let i = 0; i < 50 && !job.done; i++) {
    await new Promise((r) => setTimeout(r, 50));
    job = JSON.parse((await raw(`/api/jobs/${jobId}`, ok)).text);
  }
  assert.ok(job.done);
  assert.ok(job.steps.includes("stub step"));
  assert.equal(job.reportId, "stub");
  server.close();
});

let chromeAvailable = true;
try {
  findChrome(null);
} catch {
  chromeAvailable = false;
}

test("live teardown against a local page", { skip: !chromeAvailable, timeout: 120000 }, async () => {
  const site = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Fixture</title><script>fetch("/api/x").catch(()=>{})</script><body>${"<p>tall content</p>".repeat(200)}</body>`);
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const sitePort = (site.address() as { port: number }).port;
  const vaultDir = mkdtempSync(path.join(os.tmpdir(), "jv-"));
  const cfg = { ...loadConfig({}), vaultDir, observationMs: 4000, cdpPort: 9444 };
  const steps: string[] = [];
  try {
    const { entry, report } = await runTeardown(
      { kind: "teardown", target: `http://127.0.0.1:${sitePort}/`, clone: false },
      cfg,
      new Vault(vaultDir),
      null,
      (s) => steps.push(s),
    );
    assert.match(report, /inspect-web-page/);
    assert.match(report, /evidence `ev_/);
    assert.ok(steps.some((s) => s.startsWith("Scrolled")));
    assert.equal((await new Vault(vaultDir).list())[0]!.id, entry.id);
  } finally {
    site.close();
  }
});
