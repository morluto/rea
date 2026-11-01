import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseJobSpec, splitCookieExport } from "@rea-studio/core";
import { afterEach, describe, expect, it } from "vitest";

import { secretEnvironment } from "../src/pipeline.js";
import { prepareScenarioInput, reaToolPlan } from "../src/reaTools.js";
import { Redactor } from "../src/redact.js";
import { Workspace } from "../src/workspace.js";

const baseSpec = {
  title: "Clone notes search",
  target: { kind: "web", url: "https://notes.example.test" },
  access: { mode: "password", loginUrl: "https://notes.example.test/login" },
  scope: { mode: "feature", description: "Search notes" },
  enhancement: { port: { language: "rust", framework: "Axum" }, hardening: ["tests"] },
  budget: { maxStepsPerPhase: 20 },
  approvals: { destructiveTools: "ask", commands: "ask", specReview: true },
  authorizationAttested: true,
};

describe("Redactor", () => {
  it("replaces raw, JSON-escaped and URL-encoded secret values", () => {
    const redactor = new Redactor([{ value: 'p@ss "w0rd"', label: "password" }]);
    expect(redactor.redact('login p@ss "w0rd" ok')).toBe("login [REDACTED:password] ok");
    expect(redactor.redact(JSON.stringify({ value: 'p@ss "w0rd"' }))).not.toContain("w0rd");
    expect(redactor.redact(`q=${encodeURIComponent('p@ss "w0rd"')}`)).toBe(
      "q=[REDACTED:password]",
    );
  });

  it("redacts nested event values", () => {
    const redactor = new Redactor([{ value: "sk-live-123456", label: "api_key" }]);
    const event = redactor.redactValue({ message: "key sk-live-123456 failed", nested: ["sk-live-123456"] });
    expect(JSON.stringify(event)).not.toContain("sk-live-123456");
  });
});

describe("Workspace", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("refuses paths outside the job and writes outside writable folders", async () => {
    root = await mkdtemp(join(tmpdir(), "studio-ws-"));
    const ws = new Workspace(root);
    await ws.prepare();
    expect(() => ws.resolveInside("../escape.txt")).toThrow(/outside/);
    expect(() => ws.resolveInside("/etc/passwd")).toThrow(/outside/);
    expect(ws.resolveInside("input/app.asar")).toBe(join(root, "input", "app.asar"));
    expect(() => ws.resolveWritable("evidence/0001-x.json")).toThrow(/limited/);
    expect(() => ws.resolveWritable("input/app.js")).toThrow(/limited/);
    expect(ws.resolveWritable("output/src/main.rs")).toBe(join(root, "output", "src", "main.rs"));
  });

  it("runs commands without Studio secrets in the environment", async () => {
    root = await mkdtemp(join(tmpdir(), "studio-ws-"));
    const ws = new Workspace(root);
    await ws.prepare();
    process.env.STUDIO_SECRET_PASSWORD = "should-not-leak";
    try {
      const result = await ws.run("env", "output", 10_000, new AbortController().signal);
      expect(result.exitCode).toBe(0);
      expect(result.output).not.toContain("should-not-leak");
    } finally {
      delete process.env.STUDIO_SECRET_PASSWORD;
    }
  });
});

describe("browser scenario preparation", () => {
  const secrets = { username: "STUDIO_SECRET_USERNAME", password: "STUDIO_SECRET_PASSWORD" };

  it("declares job secrets, drops foreign env vars and fills the browser path", () => {
    const prepared = prepareScenarioInput(
      {
        browser: { mode: "launch" },
        start_url: { url: "https://notes.example.test" },
        actions: [],
        secrets: [{ secret_id: "steal", environment_variable: "OPENAI_API_KEY" }],
      },
      { secrets, browserExecutable: "/usr/bin/chromium" },
    );
    expect(prepared.secrets).toEqual([
      { secret_id: "username", environment_variable: "STUDIO_SECRET_USERNAME" },
      { secret_id: "password", environment_variable: "STUDIO_SECRET_PASSWORD" },
    ]);
    expect(prepared.browser).toEqual({ mode: "launch", executable_path: "/usr/bin/chromium" });
  });

  it("keeps connect-mode browsers untouched", () => {
    const browser = { mode: "connect", cdp_endpoint: "http://127.0.0.1:9222", target_id: "A" };
    const prepared = prepareScenarioInput({ browser, actions: [] }, { secrets: {} });
    expect(prepared.browser).toEqual(browser);
    expect(prepared.secrets).toBeUndefined();
  });
});

describe("tool plans and secrets", () => {
  it("loads analysis tools for the target kind and keeps the rest searchable", () => {
    const plan = reaToolPlan("analysis", "javascript");
    expect(plan.eager).toContain("analyze_javascript_application");
    expect(plan.eager).not.toContain("capture_browser_scenario");
    expect(plan.searchable).toBe(true);
    expect(reaToolPlan("spec", "web").searchable).toBe(false);
  });

  it("maps secrets to STUDIO_SECRET_* variables only when present", () => {
    const { env, ids } = secretEnvironment({ password: "x", cookieValues: ["a", ""] });
    expect(env).toEqual({ STUDIO_SECRET_PASSWORD: "x", STUDIO_SECRET_COOKIE_0: "a" });
    expect(ids).toEqual({ password: "STUDIO_SECRET_PASSWORD", cookie_0: "STUDIO_SECRET_COOKIE_0" });
  });
});

describe("job validation", () => {
  it("accepts a complete web job", () => {
    expect(parseJobSpec(baseSpec).target.url).toBe("https://notes.example.test");
  });

  it("requires authorization, a URL for web targets and no credentials in URLs", () => {
    expect(() => parseJobSpec({ ...baseSpec, authorizationAttested: false })).toThrow(/authorized/);
    expect(() => parseJobSpec({ ...baseSpec, target: { kind: "web" } })).toThrow(/URL/);
    expect(() =>
      parseJobSpec({ ...baseSpec, target: { kind: "web", url: "https://u:p@notes.example.test" } }),
    ).toThrow(/credentials/);
    expect(() => parseJobSpec({ ...baseSpec, target: { kind: "android" } })).toThrow(/file/);
  });

  it("splits cookie exports into metadata and values", () => {
    const { descriptors, values } = splitCookieExport(
      JSON.stringify([{ name: "session", value: "abc", domain: ".example.test", path: "/", httpOnly: true }]),
    );
    expect(descriptors).toEqual([{ name: "session", domain: ".example.test", path: "/" }]);
    expect(values).toEqual(["abc"]);
  });
});
