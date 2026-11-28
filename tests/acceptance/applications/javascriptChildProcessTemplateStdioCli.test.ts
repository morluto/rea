import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains static child stdio templates through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-child-template-stdio-");
    await writeFixtureFiles(root, {
      "entry.mjs": [
        'import { spawn, fork } from "node:child_process";',
        'throw new Error("static fixture must never execute");',
        "function run(input) {",
        '  spawn("template-pipe", [], { stdio: `pipe` });',
        '  fork("template-inherit", [], { stdio: `inherit` });',
        '  spawn("dynamic", [], { stdio: `mode-${input}` });',
        '  spawn("quoted", [], { stdio: "pipe" });',
        '  fork("silent-template", [], { silent: `yes` });',
        '  fork("silent-empty", [], { silent: `` });',
        '  fork("silent-dynamic", [], { silent: `mode-${input}` });',
        '  fork("silent-overridden", [], { stdio: "inherit", silent: `yes` });',
        "}",
      ].join("\n"),
    });
    const graph = (await analyzeJavaScriptDirectory(surface, cli, root))
      .semantic_graph;
    const children = graph.nodes.filter(
      (node) => node.kind === "child-process",
    );
    expect(children).toHaveLength(8);
    for (const [command, mode] of [
      ["template-pipe", "pipe"],
      ["template-inherit", "inherit"],
      ["dynamic", "dynamic"],
      ["quoted", "pipe"],
      ["silent-template", "pipe"],
      ["silent-empty", "default"],
      ["silent-dynamic", "dynamic"],
      ["silent-overridden", "inherit"],
    ] as const) {
      const child = children.find(
        (node) => node.properties.command === command,
      );
      if (child === undefined) throw new Error(`Missing child ${command}`);
      expect(child.properties.stdio_mode, command).toBe(mode);
      const relations = graph.relations.filter(
        (relation) =>
          relation.relation === "connects-stdio" &&
          relation.source_node_id === child.node_id,
      );
      expect(relations, command).toHaveLength(1);
      expect(relations[0]?.resolution).toBe(
        mode === "dynamic" ? "candidate" : "resolved",
      );
      expect(
        graph.nodes.find(
          (node) => node.node_id === relations[0]?.target_node_id,
        ),
      ).toMatchObject({ kind: "stdio", properties: { mode } });
      const unknowns = graph.unknowns.filter(
        (unknown) =>
          unknown.node_id === child.node_id &&
          unknown.family === "child-process" &&
          unknown.relation_kinds.includes("connects-stdio"),
      );
      expect(unknowns, command).toHaveLength(mode === "dynamic" ? 1 : 0);
      if (mode === "dynamic") expect(unknowns[0]?.reason).toBe("unknown-value");
    }
  },
);
