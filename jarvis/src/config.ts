import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export const jarvisRoot = path.resolve(here, "..");
export const repoRoot = path.resolve(jarvisRoot, "..");

export interface Config {
  readonly reaCli: string;
  readonly vaultDir: string;
  readonly port: number;
  readonly cdpPort: number;
  readonly chromePath: string | null;
  readonly headless: boolean;
  readonly observationMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    reaCli: env["JARVIS_REA_CLI"] ?? path.join(repoRoot, "scripts", "rea.mjs"),
    vaultDir: path.resolve(env["JARVIS_VAULT"] ?? path.join(jarvisRoot, "teardowns")),
    port: Number(env["JARVIS_PORT"] ?? 4777),
    cdpPort: Number(env["JARVIS_CDP_PORT"] ?? 9333),
    chromePath: env["JARVIS_CHROME"] ?? null,
    headless: env["JARVIS_HEADED"] !== "1",
    observationMs: Number(env["JARVIS_OBSERVATION_MS"] ?? 12000),
  };
}
