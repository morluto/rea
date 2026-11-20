import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CdpConnection } from "../../src/browser/CdpConnection.js";
import type { CdpEventName } from "../../src/browser/protocol/CdpEvents.js";
import { startFakeCdpBrowser } from "../fixtures/fakeCdpBrowser.js";

const scriptsRoot = resolve(import.meta.dirname, "../../scripts");

async function* scriptFiles(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* scriptFiles(path);
    else if (/\.m?js$/u.test(entry.name)) yield path;
  }
}

/**
 * JavaScript verifiers subscribe to the same `CdpConnection` as TypeScript,
 * but the compiler does not check the event names they match. They subscribe
 * through `onRegisteredEvent`, which refuses an unregistered name when the
 * subscription is made, as `CdpConnection.send` does for commands; a raw
 * `onEvent` subscriber compares names no check would catch.
 */
describe("verifier CDP event subscribers", () => {
  it("refuses an unregistered event name before subscribing", async () => {
    const browser = await startFakeCdpBrowser();
    const connection = await CdpConnection.connect(
      browser.browserWebSocketUrl,
      "inspect_web_page",
    );
    try {
      expect(() =>
        connection.onRegisteredEvent(
          "Page.notRegistered" as CdpEventName,
          () => undefined,
        ),
      ).toThrow(
        expect.objectContaining({
          _tag: "BrowserObservationError",
          reason: "protocol_error",
        }),
      );
      const received: string[] = [];
      connection.onRegisteredEvent("Page.lifecycleEvent", (registered) =>
        received.push(registered.payload.name ?? ""),
      );
      browser.emitEvent({
        method: "Page.frameDetached",
        params: { frameId: "main" },
      });
      browser.emitEvent({
        method: "Page.lifecycleEvent",
        params: { frameId: "main", loaderId: "loader", name: "load" },
      });
      await expect.poll(() => received).toEqual(["load"]);
    } finally {
      await connection.close();
      await browser.close();
    }
  });

  it("subscribe only through the registered-event check", async () => {
    const raw: string[] = [];
    for await (const path of scriptFiles(scriptsRoot)) {
      const source = await readFile(path, "utf8");
      for (const match of source.matchAll(/\.onEvent\(/gu))
        raw.push(
          `${relative(scriptsRoot, path)}:${String(source.slice(0, match.index).split("\n").length)}`,
        );
    }
    expect(raw).toEqual([]);
  });
});
