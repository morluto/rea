import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isCdpCommand,
  parseCdpCommandResult,
  type CdpCommand,
} from "../../src/browser/protocol/CdpCommands.js";

const scriptsRoot = resolve(import.meta.dirname, "../../scripts");

async function* scriptFiles(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* scriptFiles(path);
    else if (/\.(?:m?js|ts)$/u.test(entry.name)) yield path;
  }
}

/**
 * JavaScript verifiers send through the same `CdpConnection` and Playwright
 * sessions as TypeScript, but the compiler does not check their method names.
 */
describe("verifier CDP commands", () => {
  it("sends only commands with registered result schemas", async () => {
    const unregistered: string[] = [];
    let sends = 0;
    for await (const path of scriptFiles(scriptsRoot)) {
      const source = await readFile(path, "utf8");
      for (const match of source.matchAll(
        /\.send\(\s*"([A-Z][A-Za-z]*\.[a-z][A-Za-z]*)"/gu,
      )) {
        sends += 1;
        if (!isCdpCommand(match[1]!))
          unregistered.push(`${relative(scriptsRoot, path)}: ${match[1]}`);
      }
    }
    expect(sends).toBeGreaterThan(0);
    expect(unregistered).toEqual([]);
  });

  it("keeps the reply members the verifiers read", () => {
    expect(
      parseCdpCommandResult("Target.closeTarget", { success: true }),
    ).toEqual({ ok: true, value: { success: true } });
    expect(
      parseCdpCommandResult("Target.createTarget", { targetId: "page" }),
    ).toEqual({ ok: true, value: { targetId: "page" } });
    expect(
      parseCdpCommandResult("Page.navigate", {
        frameId: "main",
        loaderId: "loader",
      }),
    ).toEqual({ ok: true, value: { frameId: "main", loaderId: "loader" } });
    expect(
      parseCdpCommandResult("Page.createIsolatedWorld", {
        executionContextId: 3,
      }),
    ).toEqual({ ok: true, value: { executionContextId: 3 } });
  });

  it("rejects an unregistered run-time name as a malformed reply", () => {
    for (const name of ["Page.notRegistered", "toString", "constructor"]) {
      expect(isCdpCommand(name)).toBe(false);
      expect(parseCdpCommandResult(name as CdpCommand, {})).toEqual({
        ok: false,
        error: {
          command: name,
          pointer: "",
          issue: "No result schema is registered for this command.",
        },
      });
    }
  });
});
