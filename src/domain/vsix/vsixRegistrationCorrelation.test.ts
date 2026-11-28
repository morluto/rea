import { describe, expect, it } from "vitest";

import { graphForJavaScript } from "../../../tests/fixtures/javascriptSemanticGraph.js";
import { correlateVsixRegistrations } from "./vsixRegistrationCorrelation.js";

type ContributionKind =
  | "chat_participant"
  | "language_model_tool"
  | "mcp_server_provider"
  | "view"
  | "custom_editor";

const contributes = (
  commands: readonly string[],
  extra: {
    menus?: { menu: string; commands: (string | null)[] }[] | null;
    keybindings?: { command: string | null; key: string | null }[] | null;
    declarations?:
      | { kind: ContributionKind; id: string | null; label: string | null }[]
      | null;
  } = {},
) => ({
  commands: commands.map((command) => ({ command, title: null })),
  commands_omitted: 0,
  menus: [],
  keybindings: [],
  declarations: [],
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
    manifestRead: true,
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
    const result = correlate(
      VSCODE,
      contributes(["demo.a"], {
        menus: [{ menu: "editor/context", commands: ["demo.a", null, "x"] }],
        keybindings: [{ command: "demo.a", key: "ctrl+h" }],
      }),
    );
    expect(result.menus).toEqual([
      { menu: "editor/context", commands: ["demo.a"] },
    ]);
    expect(result.commands[0]).toMatchObject({ keybindings: ["ctrl+h"] });
  });

  it("reports unread menus and keybindings as unknown", () => {
    const result = correlate(
      VSCODE,
      contributes(["demo.a"], { menus: null, keybindings: null }),
    );
    expect(result.menus).toBeNull();
    expect(result.commands[0]).toMatchObject({ keybindings: null });
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
      manifestRead: true,
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
        declarations: [
          { kind: "chat_participant", id: "demo.chat", label: "demo" },
          { kind: "language_model_tool", id: "demo_tool", label: null },
        ],
      }),
    );
    expect(
      result.contributions.map(({ kind, id, status }) => [kind, id, status]),
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
      contributes([], { declarations: null }),
    );
    expect(result.contributions[0]?.status).toBe("undetermined");
  });

  it("correlates views and custom editors with their providers", () => {
    const result = correlate(
      `${VSCODE}vscode.window.registerTreeDataProvider("demo.tree", p);
       vscode.window.createTreeView("demo.tree", o);
       vscode.window.registerWebviewViewProvider("demo.web", p);
       vscode.window.registerCustomEditorProvider("demo.editor", p);`,
      contributes([], {
        declarations: [
          { kind: "view", id: "demo.tree", label: "Tree" },
          { kind: "view", id: "demo.web", label: null },
          { kind: "custom_editor", id: "demo.other", label: null },
        ],
      }),
    );
    expect(
      result.contributions.map(({ id, status, registrations }) => [
        id,
        status,
        registrations.length,
      ]),
    ).toEqual([
      ["demo.tree", "registered", 2],
      ["demo.web", "registered", 1],
      ["demo.editor", "registered_undeclared", 1],
      ["demo.other", "not_found", 0],
    ]);
  });

  const withGraph = (
    change: (graph: ReturnType<typeof graphForJavaScript>) => unknown,
  ) =>
    correlateVsixRegistrations({
      contributes: contributes(["demo.a"]),
      entryPoints: ["app.js"],
      manifestRead: true,
      semanticGraph: change(
        graphForJavaScript(VSCODE + "vscode.f();"),
      ) as ReturnType<typeof graphForJavaScript>,
    });

  it("makes no absence claim from a graph without callee facts", () => {
    const result = withGraph(({ callee_fact_modules: _, ...graph }) => graph);
    expect(result.commands[0]?.status).toBe("undetermined");
  });

  it("treats a skipped file as not analyzed", () => {
    const result = withGraph((graph) => ({
      ...graph,
      unknowns: [
        {
          family: "call-flow",
          reason: "incomplete-module",
          evidence: {
            location: {
              available: true,
              value: { kind: "artifact-path", path: "app.js" },
            },
          },
        },
      ],
    }));
    expect(result.entry_points).toEqual([{ path: "app.js", analyzed: false }]);
    expect(result.commands[0]?.status).toBe("undetermined");
  });

  it.each([
    ["omitted commands", { commands_omitted: 3 }, true],
    ["an unread manifest", {}, false],
  ])("does not call a command undeclared with %s", (_, extra, manifestRead) => {
    const result = correlateVsixRegistrations({
      contributes: { ...contributes([]), ...extra },
      entryPoints: ["app.js"],
      manifestRead,
      semanticGraph: graphForJavaScript(
        `${VSCODE}vscode.commands.registerCommand("demo.a", f);`,
      ),
    });
    expect(result.commands[0]?.status).toBe("undetermined");
  });
});

it("is undetermined when a call's literal identifier exceeded a limit", () => {
  const result = correlate(
    `${VSCODE}vscode.commands.registerCommand("${"x".repeat(2_000_000)}", f);`,
    contributes(["demo.a"]),
  );
  expect(result.commands.map(({ status }) => status)).toEqual(["undetermined"]);
});
