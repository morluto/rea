import { spawn } from "node:child_process";

export interface ReaResult {
  readonly ok: boolean;
  readonly json: unknown;
  readonly raw: string;
  readonly stderr: string;
}

/** Runs one REA CLI command with --json. Uses the same CLI workflows agents use via MCP. */
export function runRea(
  cli: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<ReaResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(signal ? { signal } : {}),
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => resolve({ ok: false, json: null, raw: out, stderr: String(e) }));
    child.on("close", (code) => {
      let json: unknown = null;
      try {
        json = JSON.parse(out);
      } catch {
        // non-JSON output is kept in raw
      }
      resolve({ ok: code === 0 && json !== null, json, raw: out, stderr: err });
    });
  });
}
