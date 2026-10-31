import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CdpSession, CleanBrowser, findChrome, sleep } from "./browser.ts";
import type { Config } from "./config.ts";
import type { ModelBackend } from "./models.ts";
import { runRea } from "./rea.ts";
import { Vault, slugFor, type TeardownEntry } from "./vault.ts";

export type Emit = (step: string) => void;

export interface Command {
  readonly kind: "teardown" | "chat";
  readonly target?: string;
  readonly clone: boolean;
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/i;
const REVERSE_RE = /\b(reverse[- ]?engineer|teardown|tear down|analy[sz]e|inspect|clone)\b/i;
const CLONE_RE = /\b(clone|rebuild|recreate|replicate)\b/i;

/** Parses a natural-language command. Only http(s) URLs are torn down; anything else is chat. */
export function parseCommand(text: string): Command {
  const match = URL_RE.exec(text);
  if (match && REVERSE_RE.test(text)) {
    return {
      kind: "teardown",
      target: match[0].replace(/[.,;)]+$/, ""),
      clone: CLONE_RE.test(text),
    };
  }
  return { kind: "chat", clone: false };
}

interface EvidenceLike {
  readonly evidence_id?: string;
  readonly operation?: string;
  readonly limitations?: readonly string[];
  readonly normalized_result?: unknown;
}

function digest(op: string, json: unknown): string {
  const ev = (json ?? {}) as EvidenceLike;
  const nr = ev.normalized_result;
  const shape =
    nr && typeof nr === "object"
      ? Object.entries(nr as Record<string, unknown>)
          .map(([k, v]) => `${k}${Array.isArray(v) ? `[${v.length}]` : ""}`)
          .join(", ")
      : "n/a";
  return `- **${op}** — evidence \`${ev.evidence_id ?? "unavailable"}\`; fields: ${shape}`;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}

export interface TeardownResult {
  readonly entry: TeardownEntry;
  readonly report: string;
}

export async function runTeardown(
  cmd: Command,
  cfg: Config,
  vault: Vault,
  model: ModelBackend | null,
  emit: Emit,
  signal?: AbortSignal,
): Promise<TeardownResult> {
  const target = cmd.target;
  if (!target) throw new Error("No target URL.");
  const id = slugFor(target);
  const dir = await vault.create(id);
  const evidenceDir = path.join(dir, "evidence");
  await mkdir(evidenceDir, { recursive: true });

  const browser = new CleanBrowser(findChrome(cfg.chromePath), cfg.cdpPort, cfg.headless);
  const digests: string[] = [];
  const limitations: string[] = [];
  const raw: Record<string, unknown> = {};
  let cloneStatus: TeardownEntry["cloneStatus"] = "none";
  let cloneNote = "";
  let scrollSteps = 0;

  try {
    emit("Launching clean browser profile");
    await browser.launch();
    const initial = await browser.pageTarget();
    const cdp = await CdpSession.connect(initial.webSocketDebuggerUrl);
    emit(`Navigating to ${target}`);
    await cdp.navigate(target);
    const targetId = (await browser.pageTarget()).id;

    emit(`REA observing session (${cfg.observationMs} ms) while scrolling the page`);
    const observed = runRea(
      cfg.reaCli,
      ["observe-web-session", browser.endpoint, targetId, "--observation-ms", String(cfg.observationMs)],
      signal,
    );
    await sleep(500);
    scrollSteps = await cdp.scrollThrough();
    emit(`Scrolled ${scrollSteps} step(s)`);
    const steps: [string, Promise<{ ok: boolean; json: unknown; stderr: string }>][] = [
      ["observe-web-session", observed],
    ];
    for (const [op, args] of [
      ["inspect-web-page", ["--observation-ms", "1500"]],
      ["analyze-web-bundle", ["--observation-ms", "1500"]],
      ["capture-web-screenshot", []],
    ] as const) {
      emit(`REA ${op}`);
      steps.push([op, runRea(cfg.reaCli, [op, browser.endpoint, targetId, ...args], signal)]);
      await steps[steps.length - 1]![1];
    }
    for (const [op, p] of steps) {
      const r = await p;
      raw[op] = r.json;
      if (r.ok) {
        await writeFile(path.join(evidenceDir, `${op}.json`), JSON.stringify(r.json, null, 2));
        digests.push(digest(op, r.json));
        for (const l of ((r.json as EvidenceLike).limitations ?? []).slice(0, 5)) limitations.push(l);
      } else {
        digests.push(`- **${op}** — FAILED: ${clip(r.stderr || "no output", 300)}`);
      }
    }
    emit("Evidence saved");

    let narrative = "_No model configured; showing deterministic evidence digest only._";
    if (model) {
      emit(`Summarising with ${model.name}`);
      narrative = await model.complete([
        {
          role: "system",
          content:
            "You analyse website teardown evidence produced by REA. Separate observations from inferences; note unknowns. Be concise: stack, structure, key scripts/endpoints, design system, rebuild notes.",
        },
        { role: "user", content: `Target: ${target}\n\n${clip(JSON.stringify(raw), 60000)}` },
      ], signal);
    }

    if (cmd.clone) {
      if (!model) {
        cloneNote = "Clone skipped: no model API key configured.";
      } else {
        emit("Generating clone from report");
        const html = extractHtml(
          await model.complete([
            {
              role: "system",
              content:
                "Produce ONE self-contained index.html (inline CSS/JS, no external network resources) that recreates the site's layout and visual style from the report. Reply with a single ```html code block only.",
            },
            { role: "user", content: `Report:\n${clip(narrative, 20000)}\n\nEvidence digest:\n${digests.join("\n")}` },
          ], signal),
        );
        if (!html) {
          cloneStatus = "failed";
          cloneNote = "Model returned no HTML.";
        } else {
          const cloneFile = path.join(dir, "clone", "index.html");
          await mkdir(path.dirname(cloneFile), { recursive: true });
          await writeFile(cloneFile, html);
          emit("Testing clone in headless browser");
          const check = await testClone(cdp, pathToFileURL(cloneFile).href);
          cloneStatus = check.ok ? "passed" : "failed";
          cloneNote = check.detail;
          emit(`Clone test ${cloneStatus}: ${check.detail}`);
        }
      }
    }
    cdp.close();

    const report = [
      `# Teardown: ${target}`,
      "",
      `- Id: \`${id}\``,
      `- Date: ${new Date().toISOString()}`,
      `- Browser: clean throwaway profile, ${cfg.headless ? "headless" : "headed"}, ${scrollSteps} scroll steps`,
      "",
      "## Summary",
      narrative,
      "",
      "## REA evidence",
      ...digests,
      "",
      "Full Evidence JSON: `evidence/*.json` in this folder.",
      "",
      ...(limitations.length ? ["## Limitations (from REA)", ...limitations.map((l) => `- ${l}`), ""] : []),
      ...(cmd.clone ? ["## Clone", `Status: **${cloneStatus}**. ${cloneNote}`, ""] : []),
    ].join("\n");
    await writeFile(path.join(dir, "report.md"), report);
    const entry: TeardownEntry = {
      id,
      target,
      createdAt: new Date().toISOString(),
      dir,
      summary: clip(narrative.replace(/\s+/g, " "), 200),
      cloneStatus,
    };
    await vault.record(entry);
    emit(`Report saved: ${id}`);
    return { entry, report };
  } finally {
    await browser.close();
  }
}

export function extractHtml(text: string): string | null {
  const fenced = /```html\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? (/<!doctype html|<html/i.test(text) ? text : null);
  return body?.trim() ? body.trim() : null;
}

async function testClone(
  cdp: CdpSession,
  fileUrl: string,
): Promise<{ ok: boolean; detail: string }> {
  cdp.events.length = 0;
  await cdp.navigate(fileUrl, 1500);
  const errors = cdp.events.filter((e) => e.method === "Runtime.exceptionThrown").length;
  const stats = await cdp.evaluate<{ text: number; nodes: number }>(
    "({text:document.body.innerText.trim().length,nodes:document.querySelectorAll('*').length})",
  );
  const ok = errors === 0 && stats.text > 0 && stats.nodes > 10;
  return { ok, detail: `${stats.nodes} nodes, ${stats.text} text chars, ${errors} script error(s)` };
}

export async function chat(
  text: string,
  vault: Vault,
  model: ModelBackend | null,
): Promise<string> {
  if (!model) {
    return "Try: `reverse engineer https://example.com` (add `and clone it` for a clone). Set ANTHROPIC_API_KEY, OPENAI_API_KEY or GITHUB_TOKEN to enable conversation, summaries and clones.";
  }
  const memory = await vault.memory();
  return model.complete([
    {
      role: "system",
      content: `You are Jarvis, a local reverse-engineering assistant built on REA. Tell users to say "reverse engineer <url>" to run a teardown. Long-term memory of past teardowns:\n${clip(memory, 8000) || "(none yet)"}`,
    },
    { role: "user", content: text },
  ]);
}
