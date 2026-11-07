import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

export interface TeardownEntry {
  readonly id: string;
  readonly target: string;
  readonly createdAt: string;
  readonly dir: string;
  readonly summary: string;
  readonly cloneStatus: "none" | "passed" | "failed";
}

export function slugFor(target: string, now = new Date()): string {
  let base = target;
  try {
    const u = new URL(target);
    base = u.host + u.pathname;
  } catch {
    // not a URL; slug the raw text
  }
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "target";
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${slug}-${stamp}`;
}

export class Vault {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private get indexPath(): string {
    return path.join(this.root, "index.json");
  }
  private get memoryPath(): string {
    return path.join(this.root, "memory.md");
  }

  async create(id: string): Promise<string> {
    const dir = path.join(this.root, id);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async list(): Promise<TeardownEntry[]> {
    try {
      return JSON.parse(await readFile(this.indexPath, "utf8")) as TeardownEntry[];
    } catch {
      return [];
    }
  }

  async record(entry: TeardownEntry): Promise<void> {
    const entries = (await this.list()).filter((e) => e.id !== entry.id);
    entries.unshift(entry);
    await mkdir(this.root, { recursive: true });
    await writeFile(this.indexPath, JSON.stringify(entries, null, 2));
    await appendFile(
      this.memoryPath,
      `- ${entry.createdAt} — **${entry.target}** → \`${entry.id}\` (clone: ${entry.cloneStatus}). ${entry.summary}\n`,
    );
  }

  async memory(): Promise<string> {
    try {
      return await readFile(this.memoryPath, "utf8");
    } catch {
      return "";
    }
  }

  /** Resolves a report file for a known id only, so ids cannot escape the vault. */
  async readReport(id: string): Promise<string | null> {
    const known = (await this.list()).find((e) => e.id === id);
    if (!known) return null;
    try {
      return await readFile(path.join(this.root, known.id, "report.md"), "utf8");
    } catch {
      return null;
    }
  }
}
