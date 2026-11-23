import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { minimalElfImage } from "../../fixtures/nativeHeaders.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import type { TestCli } from "../../support/cli/cliFixture.js";

const elfHeader = new Uint8Array(minimalElfImage());

interface Page {
  items: {
    logical_path: string;
    artifact_kind?: string;
    declared_size?: number | null;
  }[];
  coverage: { total: number; next_offset: number | null };
}

/** Inspect one archive through the CLI and page its retained inventory. */
const inventoryOf = async (
  cli: TestCli,
  prefix: string,
  entries: (writer: ZipWriter<Uint8Array>) => Promise<void>,
) => {
  const root = await createTestTempDirectory(prefix);
  const archive = join(root, "app.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await entries(writer);
  await writeFile(archive, await writer.close());
  const bundlePath = join(root, "bundle.json");
  const inspected = await cli.run({
    arguments: [
      "inspect-artifact",
      archive,
      "--detail",
      "summary",
      "--evidence_output",
      bundlePath,
      "--json",
    ],
  });
  expect(inspected.exitCode).toBe(0);
  const parent = parseEvidenceBundle(
    JSON.parse(await readFile(bundlePath, "utf8")),
  ).records.find((record) => record.operation === "inspect_artifact")!;
  const request = async (selection: Record<string, unknown>) => {
    const path = join(root, "view.json");
    await writeFile(
      path,
      JSON.stringify({
        source: { kind: "inline", evidence: parent },
        view: { kind: "inventory", collection: "occurrences", ...selection },
      }),
    );
    return cli.run({ arguments: ["inspect-analysis-view", path, "--json"] });
  };
  const view = async (selection: Record<string, unknown>) => {
    const projected = await request(selection);
    expect(projected.exitCode).toBe(0);
    return parseEvidence(projected.json).normalized_result as unknown as Page;
  };
  return { request, view };
};

const paths = (page: Page) => page.items.map((item) => item.logical_path);

cliTest(
  "selects inventory occurrences by recognized artifact kind",
  async ({ cli }) => {
    const { view } = await inventoryOf(
      cli,
      "rea-inventory-kinds-cli-",
      async (writer) => {
        await writer.add(
          "main.js",
          new TextReader("require('./build/Release/a.node');\n"),
        );
        await writer.add(
          "build/Release/a.node",
          new Uint8ArrayReader(elfHeader),
        );
        await writer.add("lib/b.node", new Uint8ArrayReader(elfHeader));
        await writer.add("lib/c.so", new Uint8ArrayReader(elfHeader));
      },
    );
    const fields = ["logical_path", "artifact_kind"];

    const addons = await view({ fields, artifact_kinds: ["native-addon"] });
    expect(paths(addons).sort()).toEqual([
      "build/Release/a.node",
      "lib/b.node",
    ]);
    expect(addons.coverage.total).toBe(2);
    expect(
      addons.items.every((item) => item.artifact_kind === "native-addon"),
    ).toBe(true);

    // Selectors intersect; an empty kind list selects nothing.
    const intersected = await view({
      fields,
      artifact_kinds: ["native-addon", "dynamic-library"],
      logical_paths: ["lib/b.node", "lib/c.so", "main.js"],
    });
    expect(paths(intersected)).toEqual(["lib/b.node", "lib/c.so"]);
    const none = await view({ fields, artifact_kinds: [] });
    expect(none.items).toEqual([]);
    expect(none.coverage.total).toBe(0);
  },
);

/** Libraries one and two ABI levels deep, sibling assets and one directory entry. */
const layeredInventory = (cli: TestCli, prefix: string) => {
  const text = (bytes: number) => new TextReader("x".repeat(bytes));
  return inventoryOf(cli, prefix, async (writer) => {
    await writer.add("README", text(30));
    await writer.add("lib/", undefined, { directory: true });
    await writer.add("lib/arm64/libsmall.so", text(10));
    await writer.add("lib/x86_64/libbig.so", text(500));
    await writer.add("lib/x86_64/deep/libdeep.so", text(400));
    await writer.add("assets/a/b.txt", text(200));
    await writer.add("assets/c.txt", text(200));
    await writer.add("assets.txt", text(5));
  });
};
const sizeFields = ["logical_path", "declared_size"];

cliTest("selects inventory occurrences by path glob", async ({ cli }) => {
  const { request, view } = await layeredInventory(
    cli,
    "rea-inventory-globs-cli-",
  );
  const fields = sizeFields;

  // One ABI directory deep; ** spans the deeper library.
  expect(paths(await view({ fields, path_globs: ["lib/*/*.so"] }))).toEqual([
    "lib/arm64/libsmall.so",
    "lib/x86_64/libbig.so",
  ]);
  expect(
    paths(await view({ fields, path_globs: ["lib/**/lib?ee?.so"] })),
  ).toEqual(["lib/x86_64/deep/libdeep.so"]);
  // A trailing ** selects everything below, not the sibling file.
  expect(paths(await view({ fields, path_globs: ["assets/**"] }))).toEqual([
    "assets/a/b.txt",
    "assets/c.txt",
  ]);
  // Root entries exclude the container's own "." row; globs union, then
  // intersect with entry kinds.
  expect(
    paths(
      await view({
        fields,
        path_globs: ["*", "assets/*"],
        entry_kinds: ["file"],
      }),
    ),
  ).toEqual(["README", "assets.txt", "assets/c.txt"]);
  expect((await view({ fields, path_globs: [] })).coverage.total).toBe(0);

  // A ** fused into a segment is refused at its exact field.
  const refused = await request({ path_globs: ["lib/a**b"] });
  expect(refused.exitCode).not.toBe(0);
  expect(JSON.stringify(refused.json)).toContain('"path_globs",0');
});

cliTest(
  "orders inventory occurrences by size before paging",
  async ({ cli }) => {
    const { view } = await layeredInventory(cli, "rea-inventory-order-cli-");
    const ordered = (
      direction: "ascending" | "descending",
      page: Record<string, unknown> = {},
    ) =>
      view({
        fields: sizeFields,
        path_globs: ["**"],
        order_by: { field: "declared_size", direction },
        ...page,
      });

    // Ties keep inventory order and the directory's unknown size comes last in
    // either direction.
    const largest = await ordered("descending", { offset: 0, limit: 3 });
    expect(largest.items).toEqual([
      expect.objectContaining({
        logical_path: "lib/x86_64/libbig.so",
        declared_size: 500,
      }),
      expect.objectContaining({
        logical_path: "lib/x86_64/deep/libdeep.so",
        declared_size: 400,
      }),
      expect.objectContaining({
        logical_path: "assets/a/b.txt",
        declared_size: 200,
      }),
    ]);
    expect(largest.coverage).toMatchObject({ total: 8, next_offset: 3 });
    expect(paths(await ordered("descending", { offset: 3, limit: 1 }))).toEqual(
      ["assets/c.txt"],
    );
    const descending = paths(await ordered("descending"));
    const ascending = paths(await ordered("ascending"));
    expect(descending.at(-1)).toBe("lib");
    expect(ascending[0]).toBe("assets.txt");
    expect(ascending.at(-1)).toBe("lib");

    // Compressed size ranks repetitive text below incompressible bytes even
    // though its declared size is larger.
    let state = 0x2545f491;
    const noise = Uint8Array.from({ length: 1024 }, () => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return state >>> 24;
    });
    const stored = await inventoryOf(
      cli,
      "rea-inventory-compressed-cli-",
      async (writer) => {
        await writer.add("text.txt", new TextReader("x".repeat(4096)));
        await writer.add("noise.bin", new Uint8ArrayReader(noise));
        await writer.add("empty/", undefined, { directory: true });
      },
    );
    const by = async (field: "declared_size" | "compressed_size") =>
      paths(
        await stored.view({
          fields: ["logical_path", field],
          path_globs: ["**"],
          order_by: { field, direction: "descending" },
        }),
      );
    expect(await by("declared_size")).toEqual([
      "text.txt",
      "noise.bin",
      "empty",
    ]);
    expect(await by("compressed_size")).toEqual([
      "noise.bin",
      "text.txt",
      "empty",
    ]);
  },
);
