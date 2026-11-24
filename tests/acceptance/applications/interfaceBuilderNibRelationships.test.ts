import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, onTestFinished } from "vitest";
import { build } from "plist";

import { encodeNibArchiveFixture } from "../../../src/artifacts/apple/NibArchive.fixture.js";
import { interfaceBuilderAnalysisSchema } from "../../../src/domain/apple/interfaceBuilderGraph.js";
import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createTestMcp } from "../../support/mcp/mcpFixture.js";
import { openBundleResourcesTarget } from "../../support/mcp/artifactSession.js";

type Objects = Parameters<typeof encodeNibArchiveFixture>[0]["objects"];
const cases: readonly {
  name: string;
  objects: Objects;
  links: readonly (readonly [string, string])[];
  complete: boolean;
  registryDiagnostic?: string;
  decodeRejected?: boolean;
}[] = [
  {
    name: "archive owner alone does not establish a visual hierarchy",
    objects: [
      { classIndex: 0, values: { NSRoot: { ref: 1 } } },
      { classIndex: 3, values: {} },
    ],
    links: [],
    complete: false,
  },
  {
    name: "repeated registry declarations",
    objects: [
      {
        classIndex: 0,
        values: [
          ["NSRoot", { ref: 1 }],
          ["NSRoot", { ref: 2 }],
        ],
      },
      { classIndex: 3, values: {} },
      { classIndex: 3, values: {} },
    ],
    links: [],
    complete: false,
  },
  {
    name: "malformed registry owner with valid empty collections",
    objects: [
      {
        classIndex: 0,
        values: {
          NSRoot: "unknown",
          NSObjectsKeys: { ref: 1 },
          NSObjectsValues: { ref: 2 },
        },
      },
      { classIndex: 2, values: {} },
      { classIndex: 2, values: {} },
    ],
    links: [],
    complete: false,
  },
  {
    name: "dangling registry owner is rejected at the archive boundary",
    objects: [
      {
        classIndex: 0,
        values: {
          NSRoot: { ref: 99 },
          NSObjectsKeys: { ref: 2 },
          NSObjectsValues: { ref: 3 },
        },
      },
      { classIndex: 1, values: {} },
      { classIndex: 2, values: { "NS.objects": { ref: 1 } } },
      { classIndex: 2, values: { "NS.objects": { ref: 99 } } },
    ],
    links: [],
    complete: false,
    decodeRejected: true,
  },
  {
    name: "superview direction when the archive owner is a view",
    objects: [
      { classIndex: 0, values: { NSRoot: { ref: 1 } } },
      { classIndex: 1, values: { NSSuperview: { ref: 2 } } },
      { classIndex: 1, values: {} },
    ],
    links: [["2", "1"]],
    complete: false,
  },
  {
    name: "conflicting child collections and superview",
    objects: [
      { classIndex: 1, values: { NSSubviews: { ref: 3 } } },
      { classIndex: 1, values: { NSSuperview: { ref: 2 } } },
      { classIndex: 1, values: {} },
      { classIndex: 2, values: { "NS.objects": { ref: 1 } } },
    ],
    links: [],
    complete: false,
  },
  {
    name: "registry ownership without an encoded view parent",
    registryDiagnostic:
      "NSObjectsKeys/NSObjectsValues pair child 3 with registry value 2",
    objects: [
      {
        classIndex: 0,
        values: {
          NSRoot: { ref: 1 },
          NSObjectsKeys: { ref: 4 },
          NSObjectsValues: { ref: 5 },
        },
      },
      { classIndex: 3, values: {} },
      { classIndex: 3, values: {} },
      { classIndex: 1, values: {} },
      { classIndex: 2, values: { "NS.objects": { ref: 3 } } },
      { classIndex: 2, values: { "NS.objects": { ref: 2 } } },
    ],
    links: [],
    complete: false,
  },
  {
    name: "repeated identical child links",
    objects: [
      { classIndex: 1, values: { subviews: { ref: 2 } } },
      { classIndex: 1, values: { NSSuperview: { ref: 0 } } },
      {
        classIndex: 2,
        values: [
          ["NS.objects", { ref: 1 }],
          ["NS.objects", { ref: 1 }],
        ],
      },
    ],
    links: [["0", "1"]],
    complete: true,
  },
  {
    name: "key-view navigation is retained without visual containment",
    objects: [
      {
        classIndex: 1,
        values: { NSNextKeyView: { ref: 1 }, NSPreviousKeyView: { ref: 1 } },
      },
      { classIndex: 1, values: {} },
      { classIndex: 1, values: { NSSuperview: { ref: 0 } } },
    ],
    links: [["0", "2"]],
    complete: true,
  },
  {
    name: "known non-view cells retain control backreferences without hierarchy claims",
    objects: [
      {
        classIndex: 0,
        values: {
          NSRoot: { ref: 1 },
          NSObjectsKeys: { ref: 4 },
          NSObjectsValues: { ref: 5 },
        },
      },
      { classIndex: 3, values: {} },
      { classIndex: 1, values: {} },
      { classIndex: 4, values: { NSControlView: { ref: 2 } } },
      { classIndex: 2, values: { "NS.objects": { ref: 3 } } },
      { classIndex: 2, values: { "NS.objects": { ref: 2 } } },
      { classIndex: 1, values: { NSSuperview: { ref: 2 } } },
    ],
    links: [["2", "6"]],
    complete: true,
  },
  {
    name: "text field cells retain ownership without visual hierarchy claims",
    objects: [
      {
        classIndex: 0,
        values: {
          NSRoot: { ref: 1 },
          NSObjectsKeys: { ref: 4 },
          NSObjectsValues: { ref: 5 },
        },
      },
      { classIndex: 3, values: {} },
      { classIndex: 1, values: { NSCell: { ref: 3 } } },
      { classIndex: 6, values: { NSControlView: { ref: 2 } } },
      { classIndex: 2, values: { "NS.objects": { ref: 3 } } },
      { classIndex: 2, values: { "NS.objects": { ref: 2 } } },
      { classIndex: 1, values: { NSSuperview: { ref: 2 } } },
    ],
    links: [["2", "6"]],
    complete: true,
  },
  {
    name: "unknown cell classes retain unknown registry parentage",
    objects: [
      {
        classIndex: 0,
        values: {
          NSRoot: { ref: 1 },
          NSObjectsKeys: { ref: 4 },
          NSObjectsValues: { ref: 5 },
        },
      },
      { classIndex: 3, values: {} },
      { classIndex: 1, values: {} },
      { classIndex: 5, values: { NSControlView: { ref: 2 } } },
      { classIndex: 2, values: { "NS.objects": { ref: 3 } } },
      { classIndex: 2, values: { "NS.objects": { ref: 2 } } },
    ],
    links: [],
    complete: false,
    registryDiagnostic:
      "NSObjectsKeys/NSObjectsValues pair child 3 with registry value 2",
  },
  {
    name: "unrecognized relationship fields",
    objects: [
      { classIndex: 1, values: { preview: { ref: 1 } } },
      { classIndex: 1, values: {} },
    ],
    links: [],
    complete: false,
  },
];

const expectArchiveRelationships = (
  report: ReturnType<typeof interfaceBuilderAnalysisSchema.parse>,
  archives: readonly ((typeof cases)[number] & { file: string })[],
) => {
  const objectsById = new Map(
    report.graph.nodes
      .filter(
        ({ attributes }) =>
          typeof attributes.interface_builder_object_id === "string",
      )
      .map((node) => [node.id, node]),
  );
  const objectLinks = report.graph.edges.flatMap((edge) => {
    const from = objectsById.get(edge.from);
    const to = edge.to === null ? undefined : objectsById.get(edge.to);
    if (edge.relation !== "contains" || from === undefined || to === undefined)
      return [];
    const archive = from.evidence[0]?.artifact_path;
    expect(to.evidence[0]?.artifact_path).toBe(archive);
    return [
      [
        archive,
        from.attributes.interface_builder_object_id,
        to.attributes.interface_builder_object_id,
      ],
    ];
  });
  expect(objectLinks).toEqual(
    archives.flatMap(({ file, links }) =>
      links.map(([from, to]) => [`Contents/Resources/${file}`, from, to]),
    ),
  );

  for (const {
    file,
    name,
    objects,
    decodeRejected,
    registryDiagnostic,
  } of archives) {
    const path = `Contents/Resources/${file}`;
    if (decodeRejected)
      expect(report.limitations.join("\n"), name).toContain(
        `${path}: NIBArchive object reference is outside the object table`,
      );
    const documentObjects = [...objectsById.values()].filter(
      ({ evidence }) => evidence[0]?.artifact_path === path,
    );
    for (const [index, object] of objects.entries()) {
      if (
        decodeRejected ||
        ![1, 4, 5, 6].includes(object.classIndex) ||
        Array.isArray(object.values)
      )
        continue;
      const node = documentObjects.find(
        ({ attributes }) =>
          attributes.interface_builder_object_id === String(index),
      );
      for (const [key, value] of Object.entries(object.values)) {
        if (typeof value !== "object" || value === null || !("ref" in value))
          continue;
        expect(node?.attributes.nibValues, name).toMatchObject({
          [key]: { objectID: String(value.ref) },
        });
      }
    }
    if (registryDiagnostic !== undefined)
      expect(
        report.limitations.some(
          (line) => line.includes(path) && line.includes(registryDiagnostic),
        ),
        name,
      ).toBe(true);
  }
};

cliTest(
  "preserves each NIB's relationship evidence through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-nib-relationships-");
    const app = join(root, "Fixture.app");
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
      build({ CFBundleExecutable: "Fixture" }),
    );
    const archives = cases.map((testCase, index) => ({
      ...testCase,
      file: testCase.decodeRejected
        ? "00-dangling.nib"
        : `${String(index).padStart(2, "0")}.nib`,
    }));
    for (const { file, objects } of archives)
      await writeFile(
        join(resources, file),
        encodeNibArchiveFixture({
          classes: [
            "NSIBObjectData",
            "NSView",
            "NSArray",
            "NSCustomObject",
            "NSButtonCell",
            "CustomButtonCell",
            "NSTextFieldCell",
          ],
          objects,
        }),
      );
    const output = await cli.run({
      arguments: ["decode-interface-builder", app, "--json"],
      environment: { REA_LOG_LEVEL: "silent", REA_ANALYSIS_PROVIDER: "auto" },
    });
    expect(output.exitCode, output.stdout + output.stderr).toBe(0);
    const report = interfaceBuilderAnalysisSchema.parse(
      parseEvidence(output.json).normalized_result,
    );
    expect(
      report.documents.map(({ relative_path, hierarchy_complete }) => [
        relative_path,
        hierarchy_complete,
      ]),
    ).toEqual(
      archives
        .filter(({ decodeRejected }) => !decodeRejected)
        .map(({ file, complete }) => [`Contents/Resources/${file}`, complete]),
    );
    expect(report.graph.coverage).toContainEqual(
      expect.objectContaining({
        facet: "archive_decode",
        status: "partial",
        reason: "one_or_more_archives_invalid",
        examined: archives.length,
      }),
    );

    expectArchiveRelationships(report, archives);

    const mcp = createTestMcp();
    onTestFinished(async () => mcp.close());
    const client = await openBundleResourcesTarget(mcp, onTestFinished, app);
    const result = await client.callTool({
      name: "decode_interface_builder",
      arguments: {},
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(
      interfaceBuilderAnalysisSchema.parse(
        parseEvidence(result.structuredContent).normalized_result,
      ),
    ).toEqual(report);
    const rejectedOnly = await client.callTool({
      name: "decode_interface_builder",
      arguments: { max_documents: 1 },
    });
    expect(rejectedOnly.isError, JSON.stringify(rejectedOnly)).not.toBe(true);
    const rejected = interfaceBuilderAnalysisSchema.parse(
      parseEvidence(rejectedOnly.structuredContent).normalized_result,
    );
    expect(rejected.documents).toEqual([]);
    expect(rejected.limitations.join("\n")).toContain(
      "Contents/Resources/00-dangling.nib: NIBArchive object reference is outside the object table",
    );
  },
);
