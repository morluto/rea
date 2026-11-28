import { describe, expect, it } from "vitest";

import { graphForJavaScript } from "../../../tests/fixtures/javascriptSemanticGraph.js";
import { correlateVsixRegistrations } from "./vsixRegistrationCorrelation.js";

type AiKind =
  | "chat_participant"
  | "language_model_tool"
  | "mcp_server_provider";

const contributes = (
  commands: readonly string[],
  extra: {
    menus?: { menu: string; command: string | null }[] | null;
    keybindings?: { command: string | null; key: string | null }[] | null;
    ai?: { kind: AiKind; id: string | null; label: string | null }[] | null;
  } = {},
) => ({
  commands: commands.map((command) => ({ command, title: null })),
  menus: [],
  keybindings: [],
  ai: [],
  ...extra,
});

const correlate = (
  source: string,
  declared: ReturnType<typeof contributes>,
  entryPoints: readonly string[] = ["app.js"],
) =>
  correlateVsixRegistrations({
    contributes: declared,
    entryPoints,
    semanticGraph: graphForJavaScript(source),
  });

const VSCODE = 'const vscode = require("vscode");\n';

describe("VS Code command correlation", () => {
  it("separates registered, missing and undeclared commands", () => {
    const result = correlate(
      `${VSCODE}vscode.commands.registerCommand("demo.a", f);
       vscode.commands.registerTextEditorCommand("demo.hidden", f);`,
      contributes(["demo.a", "demo.missing"]),
    );
    expect(
      result.commands.map(({ command, status }) => [command, status]),
    ).toEqual([
      ["demo.a", "registered"],
      ["demo.hidden", "registered_undeclared"],
      ["demo.missing", "not_found"],
    ]);
    expect(result.commands[0]?.registrations).toEqual([
      expect.objectContaining({
        function: "registerCommand",
        module_path: "app.js",
        line: 2,
        loader_authority: "candidate",
      }),
    ]);
    expect(result.summary).toEqual({
      declared: 2,
      registered: 1,
      not_found: 1,
      registered_undeclared: 1,
      undetermined: 0,
      unresolved_registrations: 0,
    });
  });

  it("keeps a built-at-run-time identifier unresolved", () => {
    const result = correlate(
      `${VSCODE}vscode.commands.registerCommand(prefix + ".a", f);`,
      contributes(["demo.a"]),
    );
    expect(result.commands[0]?.status).toBe("not_found");
    expect(result.unresolved_registrations).toHaveLength(1);
  });

  it("ignores same-named functions that are not from vscode", () => {
    const result = correlate(
      'const bus = require("bus"); bus.commands.registerCommand("demo.a", f);',
      contributes(["demo.a"]),
    );
    expect(result.commands[0]?.status).toBe("not_found");
    expect(result.unresolved_registrations).toEqual([]);
  });

  it("links menus and keybindings by command identifier", () => {
    const [command] = correlate(
      VSCODE,
      contributes(["demo.a"], {
        menus: [{ menu: "editor/context", command: "demo.a" }],
        keybindings: [{ command: "demo.a", key: "ctrl+h" }],
      }),
    ).commands;
    expect(command).toMatchObject({
      menus: ["editor/context"],
      keybindings: ["ctrl+h"],
    });
  });

  it("reports unread menus and keybindings as unknown", () => {
    const result = correlate(
      VSCODE,
      contributes(["demo.a"], { menus: null, keybindings: null }),
    );
    expect(result.commands[0]).toMatchObject({
      menus: null,
      keybindings: null,
    });
  });

  it.each([
    ["extension/app.js", true],
    ["extension/other.js", false],
  ])("says whether the entry point %s was analyzed", (entry, analyzed) => {
    const result = correlate(VSCODE + "vscode.f();", contributes([]), [entry]);
    expect(result.entry_points).toEqual([{ path: entry, analyzed }]);
  });

  it("does not call a command missing when no entry point was analyzed", () => {
    const result = correlate(VSCODE, contributes(["demo.a"]), ["other.js"]);
    expect(result.commands[0]?.status).toBe("undetermined");
  });

  it("treats a file with omitted call analysis as not analyzed", () => {
    const graph = graphForJavaScript(VSCODE + "vscode.f();");
    const omitted = {
      ...graph,
      coverage: { ...graph.coverage, truncated: true },
      unknowns: [
        {
          family: "call-flow",
          reason: "resource-limit",
          evidence: {
            location: {
              available: true,
              value: { kind: "artifact-path", path: "app.js" },
            },
          },
        },
      ],
    } as unknown as typeof graph;
    const result = correlateVsixRegistrations({
      contributes: contributes(["demo.a"]),
      entryPoints: ["app.js"],
      semanticGraph: omitted,
    });
    expect(result.entry_points).toEqual([{ path: "app.js", analyzed: false }]);
    expect(result.commands[0]?.status).toBe("undetermined");
    expect(result.summary).toMatchObject({ not_found: 0, undetermined: 1 });
  });

  it("correlates chat participants, tools and MCP providers", () => {
    const result = correlate(
      `${VSCODE}vscode.chat.createChatParticipant("demo.chat", f);
       vscode.lm.registerTool("demo_hidden", t);
       vscode.lm.registerMcpServerDefinitionProvider(id, p);`,
      contributes([], {
        ai: [
          { kind: "chat_participant", id: "demo.chat", label: "demo" },
          { kind: "language_model_tool", id: "demo_tool", label: null },
        ],
      }),
    );
    expect(
      result.ai_contributions.map(({ kind, id, status }) => [kind, id, status]),
    ).toEqual([
      ["chat_participant", "demo.chat", "registered"],
      ["language_model_tool", "demo_hidden", "registered_undeclared"],
      ["language_model_tool", "demo_tool", "not_found"],
    ]);
    expect(result.unresolved_registrations).toEqual([
      expect.objectContaining({
        function: "registerMcpServerDefinitionProvider",
      }),
    ]);
    expect(result.commands).toEqual([]);
  });

  it("does not call a registration undeclared when declarations are unread", () => {
    const result = correlate(
      `${VSCODE}vscode.lm.registerTool("demo_tool", t);`,
      contributes([], { ai: null }),
    );
    expect(result.ai_contributions[0]?.status).toBe("undetermined");
  });
});
