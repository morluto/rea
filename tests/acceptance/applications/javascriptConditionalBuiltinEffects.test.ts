import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains conditional built-in effects through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-conditional-builtins-");
    const source = `
      const fs = require('fs');
      const proc = require('process');
      const http = require('http');
      const { spawn } = require('child_process');
      const { setTimeout: schedule } = require('timers');
      fs.readFileSync('config.json');
      proc.env.MODE;
      const stream = fs.createReadStream('data');
      stream.close();
      http.get('http://example.test');
      spawn('tool', []);
      schedule(() => {}, 1);
    `;
    await writeFile(join(root, "candidate.MJS"), source);
    await writeFile(join(root, "proven.cjs"), source);
    await writeFile(
      join(root, "mixed.MJS"),
      `import * as builtin from 'node:fs'; const alternate = require('fs'); const selected = globalThis.flag ? builtin : alternate; selected.readFileSync('mixed.json');`,
    );
    await writeFile(
      join(root, "mixed-nested.MJS"),
      `import * as builtin from 'node:fs'; const alternate = require('fs'); const selected = globalThis.flag ? builtin : alternate; selected.promises.readFile('mixed.json');`,
    );
    await writeFile(
      join(root, "mutation.mjs"),
      `import http from 'http'; require('http').get = custom; http.get('http://example.test');`,
    );
    const result = await analyzeJavaScriptDirectory(surface, cli, root);
    const graph = result.semantic_graph;
    for (const [path, candidate] of [
      ["candidate.MJS", true],
      ["proven.cjs", false],
    ] as const) {
      const nodes = graph.nodes.filter(
        (node) =>
          node.identity.module_path === path &&
          [
            "child-process",
            "config-source",
            "request",
            "resource",
            "timer",
          ].includes(node.kind),
      );
      expect(nodes.map(({ kind }) => kind).sort()).toEqual([
        "child-process",
        "config-source",
        "config-source",
        "request",
        "resource",
        "timer",
      ]);
      for (const node of nodes) {
        expect(node.properties.builtin_authority).toBe(
          candidate ? "candidate" : undefined,
        );
        const evidence = graph.evidence_contexts.find(
          ({ context_id }) => context_id === node.evidence.context_id,
        );
        if (candidate)
          expect(evidence).toMatchObject({
            state: "inferred",
            confidence: "low",
          });
      }
      const ids = new Set(nodes.map(({ node_id }) => node_id));
      const relations = graph.relations.filter(
        ({ source_node_id, target_node_id }) =>
          ids.has(source_node_id) || ids.has(target_node_id),
      );
      for (const relation of [
        "reads-config",
        "reads-environment",
        "acquires",
        "releases",
        "constructs-request",
        "spawns",
        "schedules-timer",
      ])
        expect(relations).toContainEqual(
          expect.objectContaining({
            relation,
            resolution: candidate ? "candidate" : "resolved",
          }),
        );
      if (candidate) {
        expect(
          relations.every(({ resolution }) => resolution !== "resolved"),
        ).toBe(true);
        for (const relation of relations) {
          const evidence = graph.evidence_contexts.find(
            ({ context_id }) => context_id === relation.evidence.context_id,
          );
          expect(evidence).toMatchObject({
            state: "inferred",
            confidence: "low",
          });
        }
      }
    }
    const conditionalMutation = graph.nodes.find(
      (node) =>
        node.identity.module_path === "mutation.mjs" && node.kind === "request",
    );
    expect(conditionalMutation?.properties.builtin_authority).toBe("candidate");
    const evidence = graph.evidence_contexts.find(
      ({ context_id }) =>
        context_id === conditionalMutation?.evidence.context_id,
    );
    expect(evidence).toMatchObject({ state: "inferred", confidence: "low" });
    for (const path of ["mixed.MJS", "mixed-nested.MJS"]) {
      const mixed = graph.nodes.find(
        (node) =>
          node.identity.module_path === path && node.kind === "config-source",
      );
      expect(mixed?.properties.builtin_authority).toBe("candidate");
      expect(
        graph.evidence_contexts.find(
          ({ context_id }) => context_id === mixed?.evidence.context_id,
        ),
      ).toMatchObject({ state: "inferred", confidence: "low" });
      expect(
        graph.relations.find(
          ({ relation, source_node_id, target_node_id }) =>
            relation === "reads-config" &&
            (source_node_id === mixed?.node_id ||
              target_node_id === mixed?.node_id),
        ),
      ).toMatchObject({ resolution: "candidate" });
    }
  },
);
