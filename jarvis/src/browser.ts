import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

export function findChrome(explicit: string | null): string {
  const found = explicit ?? CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error("No Chrome-family browser found. Set JARVIS_CHROME to its path.");
  return found;
}

export interface BrowserTarget {
  readonly id: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

/** A clean, throwaway browser profile with loopback-only DevTools. */
export class CleanBrowser {
  readonly endpoint: string;
  private child: ChildProcess | null = null;
  private profile: string | null = null;

  private readonly chrome: string;
  private readonly port: number;
  private readonly headless: boolean;

  constructor(chrome: string, port: number, headless: boolean) {
    this.chrome = chrome;
    this.port = port;
    this.headless = headless;
    this.endpoint = `http://127.0.0.1:${port}`;
  }

  async launch(startUrl = "about:blank"): Promise<void> {
    this.profile = mkdtempSync(path.join(os.tmpdir(), "jarvis-profile-"));
    const args = [
      `--remote-debugging-port=${this.port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${this.profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1366,900",
      ...(this.headless ? ["--headless=new"] : []),
      startUrl,
    ];
    this.child = spawn(this.chrome, args, { stdio: "ignore", windowsHide: true });
    this.child.on("error", () => undefined);
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${this.endpoint}/json/version`);
        if (res.ok) return;
      } catch {
        // not up yet
      }
      await sleep(250);
    }
    await this.close();
    throw new Error("Browser DevTools endpoint did not open in time.");
  }

  async pageTarget(): Promise<BrowserTarget> {
    const res = await fetch(`${this.endpoint}/json/list`);
    const list = (await res.json()) as (BrowserTarget & { type: string })[];
    const page = list.find((t) => t.type === "page");
    if (!page) throw new Error("No page target available.");
    return page;
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (child?.pid) {
      if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          }).on("close", () => resolve());
        });
      } else {
        child.kill("SIGKILL");
      }
    }
    if (this.profile) {
      const dir = this.profile;
      this.profile = null;
      await sleep(300);
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // locked profile files are in the OS temp dir; leaving them is harmless
      }
    }
  }
}

export class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
  readonly events: { method: string; params: Record<string, unknown> }[] = [];

  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: unknown;
      };
      if (msg.id !== undefined) {
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      } else if (msg.method) {
        this.events.push({ method: msg.method, params: msg.params ?? {} });
      }
    });
  }

  static connect(url: string): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new CdpSession(ws)));
      ws.addEventListener("error", () => reject(new Error("CDP connection failed")));
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (msg) =>
        msg.error ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : resolve(msg.result as T),
      );
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async navigate(url: string, settleMs = 2500): Promise<void> {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Page.navigate", { url });
    await sleep(settleMs);
  }

  /** Scrolls the page top to bottom in viewport-sized steps, then back to top. */
  async scrollThrough(maxSteps = 25, stepDelayMs = 400): Promise<number> {
    let steps = 0;
    for (; steps < maxSteps; steps++) {
      const r = await this.send<{ result: { value: boolean } }>("Runtime.evaluate", {
        expression:
          "(()=>{window.scrollBy(0,Math.round(window.innerHeight*0.85));return window.scrollY+window.innerHeight>=document.documentElement.scrollHeight-2})()",
        returnByValue: true,
      });
      await sleep(stepDelayMs);
      if (r.result.value) {
        steps++;
        break;
      }
    }
    await this.send("Runtime.evaluate", { expression: "window.scrollTo(0,0)" });
    return steps;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value: T } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    return r.result.value;
  }

  close(): void {
    this.ws.close();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
