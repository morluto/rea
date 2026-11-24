import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parse } from "@babel/parser";
import { traverseFast, type Node } from "@babel/types";
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

const cdpMethod = /^[A-Z][A-Za-z]*\.[a-z][A-Za-z]*$/u;

function staticString(node: Node | undefined): string | undefined {
  if (node?.type === "StringLiteral") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

// Guard literal sends in rarely run verifiers. The runtime send owners check
// computed command names, and registered-event subscribers validate event names.
function verifierCdpCalls(source: string) {
  const commands: { name: string; line: number }[] = [];
  const rawEvents: number[] = [];
  const tree = parse(source, {
    sourceType: "unambiguous",
    plugins: ["typescript"],
  });
  traverseFast(tree, (node) => {
    if (
      node.type !== "CallExpression" &&
      node.type !== "OptionalCallExpression"
    )
      return;
    const { callee } = node;
    if (
      callee.type !== "MemberExpression" &&
      callee.type !== "OptionalMemberExpression"
    )
      return;
    const method =
      !callee.computed && callee.property.type === "Identifier"
        ? callee.property.name
        : staticString(callee.property);
    const line = callee.loc?.start.line ?? 1;
    if (method === "onEvent") {
      rawEvents.push(line);
    } else if (method === "send") {
      const name = staticString(node.arguments[0]);
      if (name !== undefined && cdpMethod.test(name))
        commands.push({ name, line });
    }
  });
  return { commands, rawEvents };
}

describe("verifier CDP source references", () => {
  it("finds static calls independent of quoting and ignores source-like text", () => {
    const source = [
      '// session.send("Page.comment"); session.onEvent(handler);',
      `const example = 'session.send("Page.example"); session.onEvent(handler);';`,
      "session.send ('Page.notRegistered');",
      'session["send"](`DOM.getDocument`);',
      "session.onEvent (handler);",
      "session?.['onEvent'](handler);",
      "session.onRegisteredEvent('Page.lifecycleEvent', handler);",
      "session.send(method);",
    ].join("\n");
    expect(verifierCdpCalls(source)).toEqual({
      commands: [
        { name: "Page.notRegistered", line: 3 },
        { name: "DOM.getDocument", line: 4 },
      ],
      rawEvents: [5, 6],
    });
  });

  it("uses registered commands and excludes raw event subscribers", async () => {
    const unregistered: string[] = [];
    const rawEvents: string[] = [];
    let sends = 0;
    for await (const path of scriptFiles(scriptsRoot)) {
      const calls = verifierCdpCalls(await readFile(path, "utf8"));
      const file = relative(scriptsRoot, path);
      sends += calls.commands.length;
      for (const { name, line } of calls.commands) {
        if (!isCdpCommand(name)) unregistered.push(`${file}:${line}: ${name}`);
      }
      for (const line of calls.rawEvents) rawEvents.push(`${file}:${line}`);
    }
    expect(sends).toBeGreaterThan(0);
    expect(unregistered).toEqual([]);
    expect(rawEvents).toEqual([]);
  });
});

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
