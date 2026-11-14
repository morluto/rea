import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseJobSpec, type JobEvent } from "@rea-studio/core";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, describe, expect, it } from "vitest";

import { runJob } from "../src/pipeline.js";
import { resolveReaLaunch } from "../src/rea.js";

const fixture = fileURLToPath(new URL("./fixtures/notes-app", import.meta.url));
const API_KEY = "sk-test-DO-NOT-LEAK-123";
const PASSWORD = "Sup3r-Secret-Pass!";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

const toolCall = (id: string, toolName: string, input: unknown) => ({
  content: [{ type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage,
  warnings: [],
});

// REA must be resolvable (a fork build, `rea` on PATH, or STUDIO_REA_BIN);
// npx would download the package, so skip in that case.
const reaAvailable = resolveReaLaunch().source !== "npx";

describe.skipIf(!reaAvailable)("runJob with a scripted model and real REA", () => {
  let root: string | undefined;
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("analyzes a JavaScript app through REA, saves evidence and never leaks secrets", async () => {
    root = await mkdtemp(join(tmpdir(), "studio-job-"));
    const workspaceRoot = root;
    const prompts: string[] = [];
    let call = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        prompts.push(JSON.stringify(options.tools ?? []));
        call += 1;
        if (call === 1) {
          return toolCall("c1", "analyze_javascript_application", {
            input_path: join(workspaceRoot, "input", "notes-app"),
          });
        }
        if (call === 2) {
          return toolCall("c2", "write_file", {
            path: "notes/analysis.md",
            content: "# Analysis\n\nsearchNotes filters notes by title or body.",
          });
        }
        return {
          content: [{ type: "text" as const, text: "Analysis complete." }],
          finishReason: { unified: "stop" as const, raw: undefined },
          usage,
          warnings: [],
        };
      },
    });

    const events: JobEvent[] = [];
    const spec = parseJobSpec({
      title: "Clone notes search",
      target: { kind: "javascript", path: fixture },
      access: { mode: "password" },
      scope: { mode: "feature", description: "The note search" },
      enhancement: { port: { language: "rust" }, hardening: ["tests"] },
      budget: { maxStepsPerPhase: 6 },
      approvals: { destructiveTools: "auto", commands: "auto", specReview: false },
      authorizationAttested: true,
    });
    const result = await runJob({
      spec,
      secrets: { username: "alice", password: PASSWORD },
      models: {
        analysis: { provider: "openai", model: "mock", apiKey: API_KEY },
        build: { provider: "openai", model: "mock", apiKey: API_KEY },
      },
      workspaceRoot,
      emit: (event) => events.push(event),
      approvals: { request: async () => ({ approved: true }) },
      signal: new AbortController().signal,
      createModel: () => model,
      phases: ["analysis"],
    });

    expect(result.status).toBe("succeeded");
    expect(call).toBe(3);

    const reaResult = events.find(
      (event) => event.type === "tool-result" && event.tool === "analyze_javascript_application",
    );
    expect(reaResult).toMatchObject({ ok: true, savedTo: expect.stringMatching(/^evidence\//) });

    const evidence = await readdir(join(workspaceRoot, "evidence"));
    expect(evidence.some((file) => file.endsWith("analyze_javascript_application.json"))).toBe(true);
    const saved = await readFile(join(workspaceRoot, "evidence", evidence[0] ?? ""), "utf8");
    expect(saved).toContain("search");

    // The REA result went back to the model wrapped as untrusted data.
    expect(prompts.join("\n")).toContain('untrusted=\\"true\\"');
    // Only the analysis tools are loaded up front; the catalog stays searchable.
    const firstTools = prompts[1] ?? "";
    expect(firstTools).toContain("analyze_javascript_application");
    expect(firstTools).toContain("search_rea_tools");
    expect(firstTools).not.toContain("decompile_all");

    await expect(readFile(join(workspaceRoot, "notes", "analysis.md"), "utf8")).resolves.toContain(
      "searchNotes",
    );

    const everything = JSON.stringify(events) + prompts.join("\n");
    expect(everything).not.toContain(API_KEY);
    expect(everything).not.toContain(PASSWORD);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "succeeded" });
  });
});
