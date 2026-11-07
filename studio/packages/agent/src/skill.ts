import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { tool, type ToolSet } from "ai";
import { z } from "zod";

import { forkRoot, type ReaLaunch } from "./rea.js";

const SKILL_NAME = "reverse-engineer-anything";

/** REA documentation worth loading on demand when the fork checkout has it. */
const REA_DOCS = [
  "browser-scenario-contract.md",
  "browser-observation.md",
  "agent-environments.md",
  "javascript-artifact-reconstruction.md",
  "javascript-application-workflows.md",
  "reconstruction-obligation-ledgers.md",
  "reconstruction-coverage.md",
  "android-analysis.md",
  "native-investigation.md",
  "process-capture.md",
];

export interface SkillBundle {
  /** SKILL.md body, the workflow REA ships for agents. */
  readonly instructions: string;
  /** Loadable reference documents by name. */
  readonly references: ReadonlyMap<string, string>;
  readonly source?: string;
}

const stripFrontmatter = (text: string): string =>
  text.startsWith("---") ? text.replace(/^---[\s\S]*?\n---\s*\n/, "") : text;

/** Locate REA's agent skill and docs from the fork or the installed package. */
export const loadSkill = (
  launch?: ReaLaunch,
  env: NodeJS.ProcessEnv = process.env,
): SkillBundle => {
  const roots = [forkRoot(), launch?.root].filter(
    (root): root is string => typeof root === "string",
  );
  const candidates = [
    env.STUDIO_REA_SKILL_DIR,
    ...roots.flatMap((root) => [
      join(root, ".agents", "skills", SKILL_NAME),
      join(root, "skills", SKILL_NAME),
    ]),
  ].filter((dir): dir is string => typeof dir === "string" && dir.length > 0);
  const dir = candidates.find((candidate) => existsSync(join(candidate, "SKILL.md")));
  const references = new Map<string, string>();
  let instructions = "";
  if (dir) {
    instructions = stripFrontmatter(readFileSync(join(dir, "SKILL.md"), "utf8"));
    const refs = join(dir, "references");
    if (existsSync(refs)) {
      for (const file of readdirSync(refs).filter((name) => name.endsWith(".md"))) {
        references.set(
          `references/${file}`,
          readFileSync(join(refs, file), "utf8"),
        );
      }
    }
  }
  for (const root of roots) {
    for (const doc of REA_DOCS) {
      const path = join(root, "docs", doc);
      const key = `docs/${basename(doc)}`;
      if (!references.has(key) && existsSync(path)) {
        references.set(key, readFileSync(path, "utf8"));
      }
    }
  }
  return { instructions, references, ...(dir ? { source: dir } : {}) };
};

/** A tool that returns one reference document, in pages. */
export const referenceTool = (skill: SkillBundle): ToolSet => {
  const names = [...skill.references.keys()];
  if (names.length === 0) return {};
  return {
    load_reference: tool({
      description: `Load a REA workflow reference or contract document. Available: ${names.join(", ")}.`,
      inputSchema: z.object({
        name: z.string().describe("One of the listed reference names."),
        page: z.number().int().min(0).default(0),
      }),
      execute: async ({ name, page }) => {
        const text = skill.references.get(name);
        if (text === undefined) {
          return `Unknown reference ${name}. Available: ${names.join(", ")}.`;
        }
        const size = 14_000;
        const chunk = text.slice(page * size, (page + 1) * size);
        const more = (page + 1) * size < text.length;
        return `${chunk}${more ? `\n… [continue with page ${page + 1}]` : ""}`;
      },
    }),
  };
};
