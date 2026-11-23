import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

import { V8InspectorProvider } from "../../../src/inspector/V8InspectorProvider.js";
import { startFakeV8Inspector } from "../../fixtures/inspector/fakeV8Inspector.js";
import { createNodeDiscoveryTempDirectory } from "../../fixtures/temporaryDirectory.js";

async function entryFile(name: string): Promise<string> {
  const root = await createNodeDiscoveryTempDirectory("rea-node-discovery-");
  const entry = join(root, name);
  await writeFile(entry, "setInterval(() => {}, 1000);\n");
  return entry;
}

test("resolves and deduplicates reported scripts independently of a lossy Windows target path", async () => {
  const entry = await entryFile("entry.js");
  const sibling = join(dirname(entry), "sibling.js");
  await writeFile(sibling, "void 0;\n");
  const entryUrl = pathToFileURL(entry).href;
  const siblingUrl = pathToFileURL(sibling).href;
  const reported = "file://C:_tools_entry.js";
  const fake = await startFakeV8Inspector({
    targetUrl: reported,
    scriptEvents: [
      entryUrl,
      entryUrl,
      siblingUrl,
      reported,
      "file://remote.test/share/entry.js",
      "ftp://example.test/unapproved.js",
    ].map((url, index) => ({
      method: "Debugger.scriptParsed",
      params: { scriptId: String(index + 1), url },
    })),
  });
  try {
    const provider = new V8InspectorProvider();
    const listed = await provider.listTargets({
      inspector_endpoint: fake.endpoint,
    });
    if (!listed.ok) throw listed.error;
    expect(listed.value.targets).toMatchObject([
      {
        target_id: fake.targetId,
        location: {
          kind: "unresolved",
          reported_url: reported,
          reason: "unverifiable-file-location",
        },
      },
    ]);
    expect(listed.value.excluded.unsupported_location).toBe(0);
    expect(fake.commands).toEqual([]);

    const missing = await provider.observe({
      inspector_endpoint: fake.endpoint,
      target_id: "not-the-selected-target",
      observation_ms: 10,
    });
    expect(missing).toMatchObject({
      ok: false,
      error: { reason: "target_not_found" },
    });
    expect(fake.commands).toEqual([]);

    const observed = await provider.observe({
      inspector_endpoint: fake.endpoint,
      target_id: fake.targetId,
      observation_ms: 10,
    });
    if (!observed.ok) throw observed.error;
    expect(observed.value.target.location).toEqual(
      listed.value.targets[0]?.location,
    );
    const { scripts } = observed.value;
    expect(scripts.observed_total).toBe(6);
    expect(scripts.excluded).toEqual({
      unsupported_location: 3,
      invalid_protocol_value: 0,
    });
    expect(scripts.parse_failed_total).toBe(0);
    expect(scripts.items).toHaveLength(2);
    expect(scripts.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: { kind: "file", file_path: entry },
          reported_url: entryUrl,
        }),
        expect.objectContaining({
          location: { kind: "file", file_path: sibling },
          reported_url: siblingUrl,
        }),
      ]),
    );
    expect(observed.value.unknowns).toContain(
      "The discovery-reported file location cannot be verified; loaded script locations are resolved independently from Debugger.scriptParsed.",
    );
    expect(fake.commands.map(({ method }) => method)).toEqual([
      "Runtime.enable",
      "Debugger.enable",
    ]);
  } finally {
    await fake.close();
  }
});

test.runIf(process.platform !== "win32")(
  "resolves literal POSIX discovery filenames independently of URL decoding",
  async () => {
    const root = await createNodeDiscoveryTempDirectory("rea-node-discovery-");
    const entry = join(root, "entry#hash.js");
    const siblings = ["entry%percent.js", "entry%23hash.js"].map((name) =>
      join(root, name),
    );
    const entries = [entry, ...siblings];
    await Promise.all(entries.map((path) => writeFile(path, "void 0;\n")));
    const fake = await startFakeV8Inspector({
      targetUrl: `file://${entry}`,
      additionalTargets: siblings.map((path) => ({ url: `file://${path}` })),
    });
    try {
      const listed = await new V8InspectorProvider().listTargets({
        inspector_endpoint: fake.endpoint,
      });
      if (!listed.ok) throw listed.error;
      expect(listed.value.targets).toHaveLength(entries.length);
      expect(
        new Map(
          listed.value.targets.map(({ target_id, location }) => [
            target_id,
            location,
          ]),
        ),
      ).toEqual(
        new Map(
          entries.map((file_path, index) => [
            fake.targetIds[index],
            { kind: "file", file_path },
          ]),
        ),
      );
      expect(listed.value.excluded.unsupported_location).toBe(0);
    } finally {
      await fake.close();
    }
  },
);

test("excludes unsupported discovery locations while retaining a lossy local path as unresolved", async () => {
  const alias = await entryFile("entry_quote.js");
  const reported = `file://${alias}`;
  const fake = await startFakeV8Inspector({
    targetUrl: "file://",
    additionalTargets: [
      "file://remote.test/share/entry.js",
      "javascript:entry()",
      "file://a:secret@remote.test/entry.js",
      reported,
    ].map((url) => ({ url })),
  });
  const provider = new V8InspectorProvider();
  try {
    const listed = await provider.listTargets({
      inspector_endpoint: fake.endpoint,
    });
    if (!listed.ok) throw listed.error;
    expect(listed.value.targets).toMatchObject([
      {
        target_id: fake.targetIds[4],
        location: {
          kind: "unresolved",
          reported_url: reported,
          reason: "unverifiable-file-location",
        },
      },
    ]);
    expect(listed.value.excluded.unsupported_location).toBe(4);

    const observed = await provider.observe({
      inspector_endpoint: fake.endpoint,
      target_id: fake.targetId,
      runtime_kind: "electron-main",
      observation_ms: 0,
    });
    expect(observed).toMatchObject({
      ok: false,
      error: { reason: "target_not_allowed" },
    });
    expect(fake.commands).toEqual([]);
  } finally {
    await provider.close();
    await fake.close();
  }
});

test.each([
  { targetType: "page" as const },
  { runtimeProduct: "Chrome/132.0" },
])("does not apply Node discovery semantics to %j", async (context) => {
  const fake = await startFakeV8Inspector({
    targetUrl: "file://C:_tools_entry.js",
    ...context,
  });
  try {
    const listed = await new V8InspectorProvider().listTargets({
      inspector_endpoint: fake.endpoint,
    });
    if (!listed.ok) throw listed.error;
    expect(listed.value.targets).toEqual([]);
    expect(listed.value.excluded.unsupported_location).toBe(1);
  } finally {
    await fake.close();
  }
});
