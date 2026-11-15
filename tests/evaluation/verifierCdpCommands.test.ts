import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CdpConnection } from "../../src/browser/CdpConnection.js";
import { startFakeCdpBrowser } from "../fixtures/fakeCdpBrowser.js";
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
 *
 * The structural check is at the send owners: `CdpConnection.send` and the
 * Playwright session refuse an unregistered command before it reaches the
 * browser, and `CdpConnection.onRegisteredEvent` and the Playwright session
 * refuse an unregistered event name when subscribing (see
 * `verifierCdpEventPayloads.test.ts`). Type-checking the verifier scripts
 * themselves is not practical (checkJs over them and the built modules they
 * import reports about 17,000 implicit `any` errors), so the text scan below
 * is only an early warning for verifiers that rarely run. It sees
 * string-literal sends only: a name built at run time or passed through a
 * variable is not scanned, and is caught only when that verifier runs.
 */
describe("verifier CDP commands", () => {
  it("refuses an unregistered command at the connection before sending it", async () => {
    const browser = await startFakeCdpBrowser();
    const connection = await CdpConnection.connect(
      browser.browserWebSocketUrl,
      "inspect_web_page",
    );
    try {
      await expect(
        connection.send("Page.notRegistered" as CdpCommand),
      ).rejects.toMatchObject({
        _tag: "BrowserObservationError",
        reason: "protocol_error",
      });
      expect(browser.commands.map(({ method }) => method)).not.toContain(
        "Page.notRegistered",
      );
    } finally {
      await connection.close();
      await browser.close();
    }
  });

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
