import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptsRoot = resolve(import.meta.dirname, "../../scripts");

async function* scriptFiles(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* scriptFiles(path);
    else if (/\.m?js$/u.test(entry.name)) yield path;
  }
}

/**
 * `CdpReceivedEvent` has no raw `params`; TypeScript enforces that for
 * `src/`. JavaScript verifiers subscribe to the same `CdpConnection`, so read
 * each `onEvent` callback's parameter and reject any raw payload access.
 */
describe("verifier CDP event subscribers", () => {
  it("read only the registered parse of each event", async () => {
    const raw: string[] = [];
    let subscribers = 0;
    for await (const path of scriptFiles(scriptsRoot)) {
      const source = await readFile(path, "utf8");
      for (const match of source.matchAll(
        /\.onEvent\(\s*(?:\(\s*(\{[^}]*\}|\w+)\s*\)|(\w+))\s*=>/gu,
      )) {
        subscribers += 1;
        const parameter = (match[1] ?? match[2])!;
        const body = source.slice(match.index, match.index + 2_000);
        const reads = parameter.startsWith("{")
          ? /\bparams\b/u.test(parameter)
          : new RegExp(
              String.raw`\b${parameter}(?:\?)?\.params\b|\b${parameter}\[\s*["']params["']\s*\]|\{[^}]*\bparams\b[^}]*\}\s*=\s*${parameter}\b`,
              "u",
            ).test(body);
        if (reads)
          raw.push(
            `${relative(scriptsRoot, path)}:${String(source.slice(0, match.index).split("\n").length)}`,
          );
      }
    }
    expect(subscribers).toBeGreaterThan(0);
    expect(raw).toEqual([]);
  });
});
