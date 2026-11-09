import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";

const processor =
  'registerProcessor("meter", class extends AudioWorkletProcessor { process() { return true; } });';

cliTest(
  "maps worklet module loads to their scripts through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-worklet-identity-");
    await writeFixtureFiles(root, {
      "app/audio.mjs": [
        "const context = new AudioContext();",
        'await context.audioWorklet.addModule(new URL("./meter-processor.js", import.meta.url));',
      ].join("\n"),
      "app/offline.mjs":
        'await new OfflineAudioContext(1, 128, 44100).audioWorklet.addModule("gain-processor.js");',
      "app/paint.mjs":
        'CSS.paintWorklet.addModule(new URL("./dots.js", import.meta.url));',
      "app/unproven.mjs":
        'export const load = (context) => context.audioWorklet.addModule(new URL("./ordinary.js", import.meta.url));',
      "app/meter-processor.js": processor,
      "app/gain-processor.js": processor,
      "app/dots.js": 'registerPaint("dots", class { paint() {} });',
      "app/ordinary.js": "export const ordinary = true;",
    });
    const result = await analyzeJavaScriptDirectory("CLI", cli, root);
    expect(result.statistics.parse_failures).toBe(0);
    const worklets = result.graph.nodes.filter(
      ({ kind }) => kind === "worklet",
    );
    expect(worklets).toHaveLength(3);
    expect(
      worklets.flatMap(({ observations }) =>
        observations.map(({ properties }) => properties),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          declared_specifier: "./meter-processor.js",
          resolved_path: "app/meter-processor.js",
          resolution_status: "resolved",
        }),
        expect.objectContaining({
          declared_specifier: "./dots.js",
          resolved_path: "app/dots.js",
          resolution_status: "resolved",
        }),
        expect.objectContaining({
          declared_specifier: null,
          resolved_path: null,
          expression:
            'new OfflineAudioContext(1, 128, 44100).audioWorklet.addModule("gain-processor.js")',
        }),
      ]),
    );
    const loads = result.graph.edges.filter(
      ({ relation, target_node_id }) =>
        relation === "loads" &&
        worklets.some(({ node_id }) => node_id === target_node_id),
    );
    expect(loads.map(({ properties }) => properties.kind)).toEqual([
      "worklet",
      "worklet",
      "worklet",
    ]);
    const mapped = result.graph.edges.filter(
      ({ relation, source_node_id }) =>
        relation === "maps_to" &&
        worklets.some(({ node_id }) => node_id === source_node_id),
    );
    expect(
      mapped.map(({ properties }) => properties.resolved_path).sort(),
    ).toEqual(["app/dots.js", "app/meter-processor.js"]);
  },
);
