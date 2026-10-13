import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { interfaceBuilderAnalysisSchema } from "../../../src/domain/apple/interfaceBuilderGraph.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "decodes a rooted UIKit keyed-archive outlet through CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-cli-uikit-outlet-");
    const app = join(root, "UIKitFixture.app");
    const contents = join(app, "Contents");
    const resources = join(contents, "Resources");
    await mkdir(resources, { recursive: true });
    await mkdir(join(contents, "MacOS"));
    await writeFile(
      join(contents, "MacOS", "Fixture"),
      thinMach(0xfeedfacf, 0x0100000c),
    );
    await writeFile(
      join(contents, "Info.plist"),
      "<plist><dict><key>CFBundleExecutable</key><string>Fixture</string></dict></plist>",
    );
    await writeFile(
      join(resources, "Main.nib"),
      await readFile(
        join(process.cwd(), "tests/fixtures/interface-builder/UIKitOutlet.xml"),
      ),
    );

    const output = await cli.run({
      arguments: ["decode-interface-builder", app, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const result = interfaceBuilderAnalysisSchema.parse(
      parseEvidence(output.json).normalized_result,
    );
    const owner = result.graph.nodes.find(
      ({ attributes }) => attributes.interface_builder_object_id === "1",
    );
    const destination = result.graph.nodes.find(
      ({ attributes }) => attributes.interface_builder_object_id === "2",
    );
    const outlet = result.graph.nodes.find(({ kind }) => kind === "outlet");
    expect(result.documents).toEqual([
      expect.objectContaining({ connection_count: 1 }),
    ]);
    expect(outlet).toMatchObject({
      id: 'ib:"Contents/Resources/Main.nib":outlet:["archive:3"]',
      name: "view",
      attributes: {
        UISource: { archiveUID: 1 },
        UIDestination: { archiveUID: 2 },
        UILabel: "view",
      },
    });
    expect(owner).toBeDefined();
    expect(destination).toBeDefined();
    expect(
      result.graph.edges.some(
        ({ from, to, relation }) =>
          from === owner?.id && to === outlet?.id && relation === "contains",
      ),
    ).toBe(true);
    expect(
      result.graph.edges.some(
        ({ from, to, relation }) =>
          from === outlet?.id &&
          to === destination?.id &&
          relation === "outlet_to",
      ),
    ).toBe(true);
    expect(result.graph.coverage).toContainEqual(
      expect.objectContaining({
        facet: "connections:Contents/Resources/Main.nib",
        status: "complete",
        examined: 1,
        omitted: 0,
      }),
    );
  },
);
