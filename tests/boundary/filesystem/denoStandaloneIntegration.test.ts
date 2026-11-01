import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { expect, it } from "vitest";

import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import {
  buildDenoSection,
  defaultDenoMetadata,
  denoElf,
  denoIntelTrailer,
} from "../../../src/artifacts/deno/DenoStandalone.fixture.js";
import { MAX_DENO_PATH_COMPONENT_BYTES } from "../../../src/artifacts/deno/DenoVirtualFs.js";
import { extractArtifact } from "../../../src/artifacts/extraction/ArtifactExtraction.js";
import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";
import { scanCanonicalArtifactInventory } from "../../fixtures/artifactInventory.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const source = "console.log('deno')\n";
const asset = "hello-asset\n";

const carrier = (): Buffer => {
  const data = Buffer.concat([Buffer.from(source), Buffer.from(asset)]);
  return denoElf(
    buildDenoSection({
      metadata: defaultDenoMetadata(),
      vfsFileData: data,
      vfs: [
        { File: { n: "main.ts", o: [0, source.length], u: true } },
        {
          File: {
            n: "asset.txt",
            o: [source.length, asset.length],
            u: true,
          },
        },
      ],
    }),
  );
};

it("extracts stored Deno virtual files through the safe output tree", async () => {
  const root = await createTestTempDirectory("rea-deno-extract-");
  const path = join(root, "app");
  await writeFile(path, carrier());
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "elf",
      outputRoot: join(root, "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(extracted.containment_verified).toBe(true);
    expect(await readFile(join(extracted.output_root, "main.ts"), "utf8")).toBe(
      source,
    );
    expect(
      await readFile(join(extracted.output_root, "asset.txt"), "utf8"),
    ).toBe(asset);
  } finally {
    await resourceScope.close();
  }
});

it("does not write embedded environment values or certificate bytes as files", async () => {
  const root = await createTestTempDirectory("rea-deno-env-");
  const path = join(root, "app");
  const secret = "embedded-env-value";
  const certificate = "embedded-ca-bytes";
  await writeFile(
    path,
    denoElf(
      buildDenoSection({
        metadata: {
          ...defaultDenoMetadata(),
          env_vars_from_env_file: { REA_DENO_TOKEN: secret },
          ca_data: [...Buffer.from(certificate)],
        },
        vfs: [{ File: { n: "main.ts", o: [0, source.length], u: true } }],
        vfsFileData: Buffer.from(source),
      }),
    ),
  );
  const resourceScope = new ArtifactResourceScope();
  try {
    await extractArtifact({
      inputPath: path,
      inputFormat: "elf",
      outputRoot: join(root, "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    const written = await readdir(join(root, "out"), {
      recursive: true,
      withFileTypes: true,
    });
    const files = written.filter((entry) => entry.isFile());
    expect(files.map((entry) => entry.name)).toContain("main.ts");
    for (const file of files) {
      const contents = await readFile(join(file.parentPath, file.name));
      expect(contents.includes(secret)).toBe(false);
      expect(contents.includes(certificate)).toBe(false);
    }
  } finally {
    await resourceScope.close();
  }
});

it("reports unknown extraction coverage for an unlisted virtual filesystem", async () => {
  const root = await createTestTempDirectory("rea-deno-unlisted-vfs-");
  const path = join(root, "app");
  await writeFile(
    path,
    denoElf(
      buildDenoSection({
        vfs: { unexpected: true },
        specifiers: [{ text: "https://example.com/mod.ts", id: 1 }],
        remoteModules: [{ specifierId: 1, data: "remote" }],
      }),
    ),
  );
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "elf",
      outputRoot: join(root, "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(extracted.coverage.status).toBe("unknown");
    expect(
      await readFile(
        join(extracted.output_root, "deno-remote/example.com/mod.ts"),
        "utf8",
      ),
    ).toBe("remote");
  } finally {
    await resourceScope.close();
  }
});

it("extracts remote specifiers whose escapes differ only in hex case", async () => {
  const root = await createTestTempDirectory("rea-deno-escape-case-");
  const path = join(root, "app");
  await writeFile(
    path,
    denoElf(
      buildDenoSection({
        specifiers: [
          { text: "https://example.com/a:b.ts", id: 1 },
          { text: "https://example.com/a%3ab.ts", id: 2 },
        ],
        remoteModules: [
          { specifierId: 1, data: "first" },
          { specifierId: 2, data: "second" },
        ],
      }),
    ),
  );
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "elf",
      outputRoot: join(root, "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(
      await readFile(
        join(extracted.output_root, "deno-remote/example.com/a%3Ab.ts"),
        "utf8",
      ),
    ).toBe("first");
    expect(
      await readFile(join(extracted.output_root, "deno-remote/1"), "utf8"),
    ).toBe("second");
  } finally {
    await resourceScope.close();
  }
});

it("publishes a remote module with a port to a Windows destination", async () => {
  const root = await createTestTempDirectory("rea-deno-remote-port-");
  const path = join(root, "app");
  const body = Buffer.from("remote");
  await writeFile(
    path,
    denoElf(
      buildDenoSection({
        specifiers: [{ text: "http://localhost:8000/mod.ts", id: 1 }],
        remoteModules: [{ specifierId: 1, data: body }],
      }),
    ),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  const remote = snapshot.occurrences.find(
    (row) =>
      row.format_metadata?.kind === "deno-standalone-entry" &&
      row.format_metadata.role === "remote-module",
  );
  if (remote === undefined) throw new Error("Expected a remote module");
  const tree = await SafeOutputTree.create(join(root, "out"), "win32");
  try {
    await tree.write(remote.logical_path, Readable.from(body), {
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
    });
  } finally {
    await tree.rollback();
  }
});

it("extracts the enclosing app of a nested Intel Deno executable", async () => {
  const root = await createTestTempDirectory("rea-deno-nested-intel-");
  const path = join(root, "app");
  const inner = denoIntelTrailer(
    buildDenoSection({
      vfs: [{ File: { n: "inner.ts", o: [0, asset.length], u: true } }],
      vfsFileData: Buffer.from(asset),
    }),
  );
  await writeFile(
    path,
    denoIntelTrailer(
      buildDenoSection({
        vfs: [
          { File: { n: "main.ts", o: [0, source.length], u: true } },
          { File: { n: "inner-app", o: [source.length, inner.length] } },
        ],
        vfsFileData: Buffer.concat([Buffer.from(source), inner]),
      }),
    ),
  );
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "mach-o",
      outputRoot: join(root, "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(await readFile(join(extracted.output_root, "main.ts"), "utf8")).toBe(
      source,
    );
    const written = await readFile(join(extracted.output_root, "inner-app"));
    expect(written.equals(inner)).toBe(true);
    await expect(
      readFile(join(extracted.output_root, "inner.ts")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await resourceScope.close();
  }
});

it("extracts indexed VFS regions alongside naturally named fallback paths", async () => {
  const root = await createTestTempDirectory("rea-deno-indexed-collision-");
  const path = join(root, "app");
  await writeFile(
    path,
    denoElf(
      buildDenoSection({
        vfsFileData: Buffer.from("abc"),
        vfs: [
          { File: { n: "n".repeat(243), o: [0, 1], m: [1, 1] } },
          { Dir: { n: "deno-vfs", e: [{ File: { n: "0", o: [2, 1] } }] } },
        ],
      }),
    ),
  );
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "elf",
      outputRoot: join(root, "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    for (const [destination, content] of [
      ["deno-vfs-1/0", "a"],
      ["deno-vfs-1/0.deno-transpiled", "b"],
      ["deno-vfs/0", "c"],
    ] as const)
      expect(
        await readFile(join(extracted.output_root, destination), "utf8"),
      ).toBe(content);
  } finally {
    await resourceScope.close();
  }
});

it("extracts generated regions alongside real files with child suffix names", async () => {
  const root = await createTestTempDirectory("rea-deno-child-collision-");
  const path = join(root, "app");
  await writeFile(
    path,
    denoElf(
      buildDenoSection({
        vfsFileData: Buffer.from("abc"),
        vfs: [
          { File: { n: "main.ts", o: [0, 1], m: [1, 1] } },
          { File: { n: "main.ts.deno-transpiled", o: [2, 1] } },
        ],
      }),
    ),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(
    snapshot.occurrences.find(
      (row) =>
        row.format_metadata?.kind === "deno-standalone-entry" &&
        row.format_metadata.role === "vfs-transpiled",
    ),
  ).toMatchObject({
    logical_path: "deno-vfs/0.vfs-transpiled",
    format_metadata: { source_path: "main.ts" },
  });
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "elf",
      outputRoot: join(root, "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    for (const [destination, content] of [
      ["main.ts", "a"],
      ["deno-vfs/0.vfs-transpiled", "b"],
      ["main.ts.deno-transpiled", "c"],
    ] as const)
      expect(
        await readFile(join(extracted.output_root, destination), "utf8"),
      ).toBe(content);
  } finally {
    await resourceScope.close();
  }
});

it("retains duplicate logical paths and refuses to extract them to one destination", async () => {
  const root = await createTestTempDirectory("rea-deno-collision-");
  const path = join(root, "app");
  await writeFile(
    path,
    denoElf(
      buildDenoSection({
        vfsFileData: Buffer.from("ab"),
        vfs: [
          { File: { n: "main.ts", o: [0, 1] } },
          { File: { n: "main.ts", o: [1, 1] } },
        ],
      }),
    ),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  expect(
    snapshot.occurrences.filter((row) => row.logical_path === "main.ts"),
  ).toHaveLength(2);
  const resourceScope = new ArtifactResourceScope();
  try {
    await expect(
      extractArtifact({
        inputPath: path,
        inputFormat: "elf",
        outputRoot: join(root, "out"),
        environment: process.env,
        integrityPolicy: "fail",
        resourceScope,
      }),
    ).rejects.toThrow(/Artifact extraction path collision/u);
  } finally {
    await resourceScope.close();
  }
});

it("extracts remote modules that differ by query or path prefix", async () => {
  const bodies = new Map<string, string>([
    ["https://example.com/mod.ts?a=1", "query-one"],
    ["https://example.com/mod.ts?a=2", "query-two"],
    ["https://example.com/foo", "foo-body"],
    ["https://example.com/foo/index.js", "index-body"],
  ]);
  const specifiers = [...bodies.keys()].map((text, id) => ({ text, id }));
  const remoteModules = specifiers.map((specifier) => ({
    specifierId: specifier.id,
    data: bodies.get(specifier.text) ?? "",
    validUtf8: true,
  }));
  const root = await createTestTempDirectory("rea-deno-remote-");
  const path = join(root, "app");
  await writeFile(
    path,
    denoElf(
      buildDenoSection({
        specifiers: [{ text: "file:///main.ts", id: 90 }, ...specifiers],
        remoteModules,
        vfsFileData: Buffer.from("local\n"),
        vfs: [{ File: { n: "main.ts", o: [0, 6], u: true } }],
      }),
    ),
  );
  const snapshot = await scanCanonicalArtifactInventory(path);
  const remotes = snapshot.occurrences.filter(
    (row) =>
      row.format_metadata?.kind === "deno-standalone-entry" &&
      row.format_metadata.role === "remote-module",
  );
  const logicalPaths = remotes.map((row) => row.logical_path);
  expect(logicalPaths.some((logical) => logical.includes("%3Fa%3D1"))).toBe(
    true,
  );
  expect(logicalPaths.some((logical) => logical.includes("%3Fa%3D2"))).toBe(
    true,
  );
  for (const logical of logicalPaths)
    for (const other of logicalPaths)
      if (logical !== other)
        expect(other.startsWith(`${logical}/`)).toBe(false);
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "elf",
      outputRoot: join(root, "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    const stored = await Promise.all(
      remotes.map(async (row) => ({
        source:
          row.format_metadata?.kind === "deno-standalone-entry"
            ? String(row.format_metadata.source_path)
            : "",
        text: await readFile(
          join(extracted.output_root, row.logical_path),
          "utf8",
        ),
      })),
    );
    const ordered = (
      rows: readonly { readonly source: string; readonly text: string }[],
    ) =>
      [...rows].sort((left, right) => left.source.localeCompare(right.source));
    expect(ordered(stored)).toEqual(
      ordered(
        [...bodies.entries()].map(([source, text]) => ({ source, text })),
      ),
    );
  } finally {
    await resourceScope.close();
  }
});

it.each([
  {
    collision: "a file occupying the remote namespace",
    vfs: [{ File: { n: "deno-remote", o: [0, 1] } }],
    destination: "deno-remote-1/0",
  },
  {
    collision: "VFS files occupying the natural and indexed remote paths",
    vfs: [
      {
        Dir: {
          n: "deno-remote",
          e: [
            {
              Dir: {
                n: "example.com",
                e: [{ File: { n: "mod.ts", o: [0, 1] } }],
              },
            },
            { File: { n: "0", o: [0, 1] } },
            { File: { n: "0-1", o: [0, 1] } },
          ],
        },
      },
    ],
    destination: "deno-remote-1/0",
  },
  {
    collision: "files occupying successive fallback namespaces",
    vfs: [
      { File: { n: "deno-remote", o: [0, 1] } },
      { File: { n: "deno-remote-1", o: [0, 1] } },
      { File: { n: "deno-remote-2", o: [0, 1] } },
    ],
    destination: "deno-remote-3/0",
  },
])(
  "extracts remote modules despite $collision",
  async ({ vfs, destination }) => {
    const root = await createTestTempDirectory("rea-deno-remote-vfs-");
    const path = join(root, "app");
    await writeFile(
      path,
      denoElf(
        buildDenoSection({
          specifiers: [{ text: "https://example.com/mod.ts", id: 1 }],
          remoteModules: [{ specifierId: 1, data: "remote", transpiled: "js" }],
          vfs,
          vfsFileData: Buffer.from("x"),
        }),
      ),
    );
    const snapshot = await scanCanonicalArtifactInventory(path);
    expect(
      snapshot.occurrences.find(
        (row) =>
          row.format_metadata?.kind === "deno-standalone-entry" &&
          row.format_metadata.role === "remote-module",
      ),
    ).toMatchObject({
      logical_path: destination,
      format_metadata: { source_path: "https://example.com/mod.ts" },
      limitations: expect.arrayContaining([expect.stringContaining("prefix")]),
    });
    const resourceScope = new ArtifactResourceScope();
    try {
      const extracted = await extractArtifact({
        inputPath: path,
        inputFormat: "elf",
        outputRoot: join(root, "out"),
        environment: process.env,
        integrityPolicy: "fail",
        resourceScope,
      });
      expect(
        await readFile(join(extracted.output_root, destination), "utf8"),
      ).toBe("remote");
      expect(
        await readFile(
          join(extracted.output_root, `${destination}.deno-transpiled`),
          "utf8",
        ),
      ).toBe("js");
      for (const row of snapshot.occurrences)
        if (
          row.format_metadata?.kind === "deno-standalone-entry" &&
          row.format_metadata.role === "vfs-file"
        )
          expect(
            await readFile(
              join(extracted.output_root, row.logical_path),
              "utf8",
            ),
          ).toBe("x");
    } finally {
      await resourceScope.close();
    }
  },
);

it("extracts virtual and remote names at the filesystem name limit", async () => {
  const atLimit = `${"a".repeat(MAX_DENO_PATH_COMPONENT_BYTES - 3)}.ts`;
  const overLimit = `${"b".repeat(MAX_DENO_PATH_COMPONENT_BYTES)}.ts`;
  const remote = `${"c".repeat(MAX_DENO_PATH_COMPONENT_BYTES - 3)}.ts`;
  const data = Buffer.from("abcdefgh");
  const root = await createTestTempDirectory("rea-deno-long-name-");
  const path = join(root, "app");
  await writeFile(
    path,
    denoElf(
      buildDenoSection({
        specifiers: [
          { text: "file:///main.ts", id: 0 },
          { text: `https://example.com/${remote}`, id: 1 },
        ],
        remoteModules: [{ specifierId: 1, data: "r", transpiled: "t" }],
        vfsFileData: data,
        vfs: [
          { File: { n: atLimit, o: [0, 1], m: [1, 1] } },
          { File: { n: overLimit, o: [2, 1] } },
          { Dir: { n: overLimit, e: [{ File: { n: "x.ts", o: [3, 1] } }] } },
        ],
      }),
    ),
  );
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "elf",
      outputRoot: join(root, "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(extracted.containment_verified).toBe(true);
    const read = (logical: string) =>
      readFile(join(extracted.output_root, logical), "utf8");
    expect(await read("deno-vfs/0")).toBe("a");
    expect(await read("deno-vfs/0.deno-transpiled")).toBe("b");
    expect(await read("deno-vfs/1")).toBe("c");
    expect(await read("deno-vfs/3")).toBe("d");
    expect(await read("deno-remote/0")).toBe("r");
    expect(await read("deno-remote/0.deno-transpiled")).toBe("t");
  } finally {
    await resourceScope.close();
  }
});

it("extracts a path too long for the host under an indexed destination", async () => {
  const part = "p".repeat(200);
  const nest = (depth: number): unknown[] =>
    depth === 0
      ? [{ File: { n: "x.ts", o: [0, 1] } }]
      : [{ Dir: { n: part, e: nest(depth - 1) } }];
  const root = await createTestTempDirectory("rea-deno-long-path-");
  const path = join(root, "app");
  await writeFile(
    path,
    denoElf(buildDenoSection({ vfsFileData: Buffer.from("a"), vfs: nest(30) })),
  );
  const leaf = (await scanCanonicalArtifactInventory(path)).occurrences.find(
    (row) =>
      row.format_metadata?.kind === "deno-standalone-entry" &&
      row.format_metadata.role === "vfs-file",
  );
  expect(leaf?.logical_path).toBe("deno-vfs/30");
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "elf",
      outputRoot: join(root, "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(
      await readFile(join(extracted.output_root, "deno-vfs/30"), "utf8"),
    ).toBe("a");
  } finally {
    await resourceScope.close();
  }
});

it("rejects a Deno verifier whose deno is not the pinned release", async () => {
  const root = await createTestTempDirectory("rea-deno-verifier-pin-");
  const bin = join(root, "bin");
  await mkdir(bin);
  const deno = join(bin, "deno");
  await writeFile(
    deno,
    "#!/bin/sh\nprintf '%s\\n' 'deno 2.9.7 (stable, release, aarch64-apple-darwin)'\n",
  );
  await chmod(deno, 0o755);
  const script = join(process.cwd(), "scripts/verify-deno-standalone.mjs");
  const source = await readFile(script, "utf8");
  const catchAt = source.indexOf("} catch (cause) {");
  const continued = source.indexOf("continue;", catchAt);
  const catchBody = source.slice(catchAt, continued);
  expect(catchBody).not.toContain("assert.");
  expect(catchBody).not.toContain("inspect-artifact");
  expect(source).toContain('const REQUIRED_DENO_VERSION = "2.9.8"');
  expect(source).toContain("importVerifierSource");
  expect(source).not.toContain('from "../dist/');
  const result = await new Promise<{
    readonly status: number | null;
    readonly stderr: string;
  }>((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      cwd: process.cwd(),
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stderr });
    });
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("2.9.8");
  expect(result.stderr).toContain("2.9.7");
});
