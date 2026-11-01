import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { deflateRawSync } from "node:zlib";
import type { Dirent } from "node:fs";
import { mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { AnalysisArtifactChangedError } from "../domain/analysisErrorCore.js";
import { pe } from "../domain/binaryTarget.fixture.js";
import { dotnetBundleFixture } from "./dotnet/DotnetBundle.fixture.js";
import { cArchiveExecutable } from "./pyinstaller/CArchive.fixture.js";
import { asarHeaderBytes } from "../../tests/fixtures/asarHeader.js";
import { javaClassFile } from "../../tests/fixtures/javaClassFile.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { windowsNativeArtifactFixture } from "../../tests/fixtures/windowsNativeArtifact.js";
import {
  ArtifactReaderFailure,
  type ArtifactReader,
} from "./ArtifactReader.js";
import {
  assembleReleaseExposureReport,
  MAX_RELEASE_EXPOSURE_INVENTORY_BYTES,
  MAX_RELEASE_EXPOSURE_INVENTORY_ENTRIES,
  MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES,
  MAX_RELEASE_EXPOSURE_PACKAGED_PE_BYTES,
  MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES,
  MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES,
  PACKAGED_NATIVE_IMAGES,
  type ReleaseExposureScan,
} from "../domain/releaseExposure.js";
import { ReleaseExposureReader } from "./ReleaseExposureReader.js";

const stableRead = vi.hoisted(() => ({
  impl: undefined as
    | undefined
    | ((
        ...args: Parameters<
          typeof import("./readStableArtifact.js").readStableArtifact
        >
      ) => ReturnType<
        typeof import("./readStableArtifact.js").readStableArtifact
      >),
}));

vi.mock("./readStableArtifact.js", async () => {
  const actual = await vi.importActual<
    typeof import("./readStableArtifact.js")
  >("./readStableArtifact.js");
  stableRead.impl = actual.readStableArtifact;
  return {
    ...actual,
    readStableArtifact: (
      ...args: Parameters<typeof actual.readStableArtifact>
    ) => (stableRead.impl ?? actual.readStableArtifact)(...args),
  };
});

const inventoryRead = vi.hoisted(() => ({
  impl: undefined as
    | undefined
    | ((
        ...args: Parameters<
          typeof import("./inventory/ArtifactInventory.js").inventoryArtifact
        >
      ) => ReturnType<
        typeof import("./inventory/ArtifactInventory.js").inventoryArtifact
      >),
}));

vi.mock("./inventory/ArtifactInventory.js", async () => {
  const actual = await vi.importActual<
    typeof import("./inventory/ArtifactInventory.js")
  >("./inventory/ArtifactInventory.js");
  return {
    ...actual,
    inventoryArtifact: (...args: Parameters<typeof actual.inventoryArtifact>) =>
      (inventoryRead.impl ?? actual.inventoryArtifact)(...args),
  };
});

const createdReaders = vi.hoisted(() => ({
  wrap: undefined as
    | undefined
    | ((reader: ArtifactReader, path: string) => ArtifactReader),
}));

vi.mock("./createArtifactReader.js", async () => {
  const actual = await vi.importActual<
    typeof import("./createArtifactReader.js")
  >("./createArtifactReader.js");
  return {
    ...actual,
    createArtifactReader: (
      ...args: Parameters<typeof actual.createArtifactReader>
    ) => {
      const reader = actual.createArtifactReader(...args);
      if (reader === undefined || createdReaders.wrap === undefined)
        return reader;
      return createdReaders.wrap(reader, args[0]);
    },
  };
});

const regularFiles = vi.hoisted(() => ({
  failClose: undefined as undefined | ((path: string) => boolean),
  failUntil: 1,
  closes: 0,
}));

vi.mock("../filesystem/RegularFile.js", async () => {
  const actual = await vi.importActual<
    typeof import("../filesystem/RegularFile.js")
  >("../filesystem/RegularFile.js");
  return {
    ...actual,
    openRegularFile: async (
      ...args: Parameters<typeof actual.openRegularFile>
    ) => {
      const opened = await actual.openRegularFile(...args);
      const close = opened.handle.close.bind(opened.handle);
      opened.handle.close = async () => {
        if (regularFiles.failClose?.(args[0]) === true) {
          regularFiles.closes += 1;
          if (regularFiles.closes <= regularFiles.failUntil)
            throw new Error(`close failed: ${args[0]}`);
        }
        await close();
      };
      return opened;
    },
  };
});

const directoryReads = vi.hoisted(() => ({
  count: 0,
  failClose: false,
  failedHandle: undefined as undefined | object,
  closeHandles: [] as object[],
}));

vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return {
    ...actual,
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      const directory = await actual.opendir(...args);
      const read = directory.read.bind(
        directory,
      ) as () => Promise<Dirent | null>;
      const close = directory.close.bind(directory);
      Object.assign(directory, {
        close: async () => {
          directoryReads.closeHandles.push(directory);
          if (directoryReads.failClose) {
            directoryReads.failedHandle = directory;
            await close();
            throw new Error("sibling directory close failed");
          }
          await close();
        },
        read: () => {
          directoryReads.count += 1;
          return read();
        },
      });
      return directory;
    },
  };
});

const PLANTED_SOURCE = "release-exposure-planted-secret-7c2e9a";
const PLANTED_KEY = "AKIAPLANT9EXPOSUREXX";
const ignoreText = (): void => undefined;

describe("ReleaseExposureReader review regressions", () => {
  it("keeps inline CSS source-map coverage unknown in files and packages", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-css-");
    const source = `body { color: red; }\n/*# sourceMappingURL=data:application/json;base64,${embeddedSourceMap().toString("base64")} */`;
    const path = join(root, "app.css");
    await writeFile(path, source);
    for (const target of [path, root]) {
      expect((await inspect(target)).source_maps).toMatchObject({
        embedded: 0,
        skipped: 1,
      });
    }
    const archive = join(root, "app.asar");
    await writeFile(
      archive,
      asarArchive([{ name: "app.css", bytes: Buffer.from(source) }]),
    );
    expect((await inspect(archive)).source_maps.skipped).toBe(1);
    await writeFile(
      path,
      Buffer.alloc(MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES + 1, 0x20),
    );
    expect((await inspect(path)).source_maps.skipped).toBe(1);
  });

  it.each(["data", "DATA"])(
    "inspects embedded sources in inline JavaScript maps with a %s: scheme",
    async (scheme) => {
      const root = await createTestTempDirectory(
        "rea-release-exposure-inline-",
      );
      const source = `const value = 1;\n//# sourceMappingURL=${scheme}:application/json;base64,${embeddedSourceMap().toString("base64")}`;
      await writeFile(join(root, "app.js"), source);
      const scanned = await inspect(root);
      expect(scanned.source_maps).toMatchObject({ embedded: 1, skipped: 0 });
      expect(scanned.source_maps.embedded_paths).toEqual([
        join(root, "app.js"),
      ]);
      await writeFile(
        join(root, "app.asar"),
        asarArchive([{ name: "app.js", bytes: Buffer.from(source) }]),
      );
      const packaged = await inspect(join(root, "app.asar"));
      expect(packaged.source_maps).toMatchObject({ embedded: 1, skipped: 0 });
    },
  );

  it.each([80, 200, 520, 550])(
    "preserves CodeView parsing truncated at %s bytes as unresolved",
    async (length) => {
      const root = await createTestTempDirectory(
        "rea-release-exposure-truncated-",
      );
      const bytes = pe(0x8664, 64, 0x0002, false, {
        pdbPath: "C:\\build\\app.pdb",
      });
      await writeFile(join(root, "app.exe"), bytes.subarray(0, length));
      const scanned = await inspect(root);
      expect(scanned.pdb).toMatchObject({ failed: 1, paths: [] });
    },
  );

  it("distinguishes an absent CodeView directory from an out-of-bounds record", async () => {
    const root = await createTestTempDirectory(
      "rea-release-exposure-codeview-",
    );
    const path = join(root, "app.exe");
    await writeFile(path, pe(0x8664));
    expect((await inspect(path)).pdb).toMatchObject({
      examined: 1,
      failed: 0,
      paths: [],
    });
    const bytes = pe(0x8664, 64, 0x0002, false, { pdbPath: "app.pdb" });
    bytes.writeUInt32LE(bytes.length + 100, 512 + 24);
    await writeFile(path, bytes);
    expect((await inspect(path)).pdb).toMatchObject({
      examined: 1,
      failed: 1,
      paths: [],
    });
  });

  it.each(["base64", "percent"])(
    "inspects inline maps without sources using %s encoding",
    async (encoding) => {
      const root = await createTestTempDirectory(
        "rea-release-exposure-plain-inline-",
      );
      const map = JSON.stringify({
        version: 3,
        sources: ["app.js"],
        names: [],
        mappings: "",
      });
      const url =
        encoding === "base64"
          ? `data:application/json;base64,${Buffer.from(map).toString("base64")}`
          : `data:application/json,${encodeURIComponent(map)}`;
      const path = join(root, "app.js");
      await writeFile(path, `/*# sourceMappingURL=${url} */`);
      expect((await inspect(path)).source_maps).toMatchObject({
        without_sources: 1,
        embedded: 0,
      });
      await writeFile(
        path,
        `const documentation = ${JSON.stringify(`//# sourceMappingURL=${url}`)};`,
      );
      expect((await inspect(path)).source_maps).toMatchObject({
        without_sources: 0,
        embedded: 0,
      });
    },
  );

  it("preserves unknown coverage for malformed inline maps and skipped JavaScript", async () => {
    const root = await createTestTempDirectory(
      "rea-release-exposure-inline-unknown-",
    );
    const path = join(root, "app.js");
    await writeFile(
      path,
      "//# sourceMappingURL=data:application/json;base64,bm90IGpzb24=",
    );
    expect((await inspect(path)).source_maps.unparsed).toBe(1);
    await writeFile(
      path,
      Buffer.alloc(MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES + 1, 0x20),
    );
    expect((await inspect(path)).source_maps.skipped).toBe(1);
  });
});

describe("ReleaseExposureReader", () => {
  it("counts embedded sources and markers without retaining their bytes", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-read-");
    const source = `export const token = "${PLANTED_SOURCE}";\n`;
    await writeFile(
      join(root, "app.js.map"),
      JSON.stringify({
        version: 3,
        file: "app.js",
        sources: ["app.js"],
        names: [],
        mappings: "",
        sourcesContent: [source],
      }),
    );
    await writeFile(join(root, "app.js"), "export const token = 1;\n");
    await writeFile(join(root, "app.pdb"), "pdb");
    await writeFile(
      join(root, "notes.txt"),
      `-----BEGIN PRIVATE KEY-----\n${PLANTED_KEY}\n-----END PRIVATE KEY-----\n`,
    );
    const reader = new ReleaseExposureReader();
    try {
      const visited = new Map<string, string>();
      const result = await reader.inspect(
        { path: root },
        undefined,
        (text, location) => visited.set(location, text),
      );
      if (!result.ok) throw result.error;
      expect(result.value.source_maps.embedded).toBe(1);
      expect(
        result.value.debug_companions.paths.some((path) =>
          path.endsWith(".pdb"),
        ),
      ).toBe(true);
      expect(visited.get(join(root, "notes.txt"))).toContain(PLANTED_KEY);
      const serialized = JSON.stringify(result.value);
      expect(serialized).not.toContain(PLANTED_SOURCE);
      expect(serialized).not.toContain(PLANTED_KEY);
      expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    } finally {
      await reader.close();
    }
  });

  it("reads a source map inside an ASAR, including one stored under a directory", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-asar-");
    const archive = sourceMapArchive();
    await writeFile(join(root, "app.asar"), archive);
    const selected = await inspect(join(root, "app.asar"));
    expect(selected.source_maps.embedded).toBe(1);
    expect(selected.extractable.formats).toContain("asar");
    expect(selected.extractable.readable_members).toBeGreaterThan(0);
    expect(selected.textLocations).toContain("dist/notes.txt");
    expect(JSON.stringify(selected)).not.toContain(PLANTED_SOURCE);
    expect(JSON.stringify(selected)).not.toContain(PLANTED_KEY);

    const bundled = await createTestTempDirectory("rea-release-exposure-app-");
    await mkdir(join(bundled, "resources"), { recursive: true });
    await writeFile(join(bundled, "resources", "app.asar"), archive);
    const directory = await inspect(bundled);
    expect(directory.source_maps.embedded).toBe(1);
    expect(directory.extractable.formats).toContain("asar");
    expect(directory.extractable.readable_members).toBeGreaterThan(0);
    expect(directory.textLocations).toContain(
      "resources/app.asar/dist/notes.txt",
    );
    expect(JSON.stringify(directory)).not.toContain(PLANTED_SOURCE);
    expect(JSON.stringify(directory)).not.toContain(PLANTED_KEY);
  });

  it("carries the inventoried digest of each native image", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-digest-");
    const elf = Buffer.alloc(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46], 0);
    await writeFile(join(root, "app"), elf);
    const sha256 = createHash("sha256").update(elf).digest("hex");
    expect((await inspect(root)).native_images).toEqual([
      { path: join(root, "app"), format: "elf", sha256 },
    ]);
    expect((await inspect(join(root, "app"))).native_images).toEqual([
      { path: join(root, "app"), format: "elf", sha256 },
    ]);
  });

  it("registers native images larger than the text budget and parses PE debug records", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-native-");
    const elf = Buffer.alloc(300 * 1024);
    elf[0] = 0x7f;
    elf[1] = 0x45;
    elf[2] = 0x4c;
    elf[3] = 0x46;
    await writeFile(join(root, "app.elf"), elf);
    const pe = Buffer.concat([
      windowsNativeArtifactFixture().bytes,
      Buffer.alloc(300 * 1024),
    ]);
    await writeFile(join(root, "app.exe"), pe);
    const calls: string[] = [];
    const real = stableRead.impl;
    stableRead.impl = async (...args) => {
      calls.push(args[0]);
      if (real === undefined) throw new Error("missing stable read");
      return real(...args);
    };
    try {
      const scanned = await inspect(root);
      expect(
        scanned.native_images.some(
          (image) => image.format === "elf" && image.path.endsWith("app.elf"),
        ),
      ).toBe(true);
      expect(scanned.pdb.examined).toBeGreaterThanOrEqual(1);
      expect(calls.some((path) => path.endsWith("app.elf"))).toBe(false);
      expect(calls.some((path) => path.endsWith("app.exe"))).toBe(true);
    } finally {
      stableRead.impl = real;
    }
  });
});

describe("ReleaseExposureReader member reads", () => {
  it("reads an uncompressed member from a package larger than 8 MiB", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-bundle-");
    const bundle = dotnetBundleFixture([
      { path: "app.js", bytes: Buffer.from("console.log(1)\n") },
    ]);
    await writeFile(
      join(root, "app.dll"),
      Buffer.concat([bundle.bytes, Buffer.alloc(8 * 1024 * 1024)]),
    );
    const scanned = await inspect(root);
    expect(scanned.extractable.formats).toContain("dotnet-bundle");
    expect(scanned.extractable.readable_members).toBeGreaterThan(0);
  });

  it("inflates a compressed source map instead of scanning compressed bytes", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-deflate-");
    const map = Buffer.from(
      JSON.stringify({
        version: 3,
        file: "app.js",
        sources: ["app.js"],
        names: [],
        mappings: "",
        sourcesContent: [`export const secret = "${PLANTED_SOURCE}";\n`],
      }),
    );
    const bundle = dotnetBundleFixture([
      { path: "app.js.map", bytes: map, compressed: true },
    ]);
    await writeFile(join(root, "app.dll"), bundle.bytes);
    const scanned = await inspect(root);
    expect(scanned.source_maps.embedded).toBe(1);
    expect(JSON.stringify(scanned)).not.toContain(PLANTED_SOURCE);
  });

  it("leaves a corrupt JavaScript source map unparsed", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-broken-");
    await writeFile(join(root, "broken.js.map"), "{not json");
    const scanned = await inspect(root);
    expect(scanned.source_maps.unparsed).toBe(1);
    expect(scanned.source_maps.embedded).toBe(0);
    expect(scanned.source_maps.without_sources).toBe(0);
    expect(
      scanned.debug_companions.paths.some((path) =>
        path.endsWith("broken.js.map"),
      ),
    ).toBe(false);
  });

  it("counts an unreadable map or text member as skipped", async () => {
    const root = await createTestTempDirectory(
      "rea-release-exposure-unreadable-",
    );
    await writeFile(join(root, "broken.js.map"), "{}\n");
    await writeFile(join(root, "notes.txt"), "hello\n");
    const real = stableRead.impl;
    stableRead.impl = async (...args) => {
      const path = String(args[0]);
      if (path.endsWith("broken.js.map") || path.endsWith("notes.txt"))
        throw new Error("unreadable member");
      if (real === undefined) throw new Error("missing stable read");
      return real(...args);
    };
    try {
      const scanned = await inspect(root);
      expect(scanned.source_maps.skipped).toBeGreaterThan(0);
      expect(scanned.text_members.skipped).toBeGreaterThan(0);
      expect(scanned.omitted.map((item) => item.subject)).toEqual(
        expect.arrayContaining(["source maps", "text members"]),
      );
    } finally {
      stableRead.impl = real;
    }
  });

  it("keeps a linker map out of the JavaScript source-map counts", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-link-");
    await writeFile(
      join(root, "foo.map"),
      "Archive member included to satisfy linker\n",
    );
    const scanned = await inspect(root);
    expect(scanned.source_maps.unparsed).toBe(0);
    expect(
      scanned.debug_companions.paths.some((path) => path.endsWith("foo.map")),
    ).toBe(true);
  });

  it.each(["external section", "decoder limit"])(
    "keeps a generic map with an unsupported %s unresolved",
    async (scenario) => {
      const root = await createTestTempDirectory("rea-release-exposure-map-");
      let map: unknown = { version: 3, sources: [], mappings: "" };
      if (scenario === "external section")
        map = {
          version: 3,
          sections: [{ offset: { line: 0, column: 0 }, url: "external.map" }],
        };
      else
        for (let depth = 0; depth < 66; depth += 1)
          map = {
            version: 3,
            sections: [{ offset: { line: 0, column: 0 }, map }],
          };
      await writeFile(join(root, "bundle.map"), JSON.stringify(map));
      const scanned = await inspect(root);
      expect(scanned.source_maps).toMatchObject({
        unparsed: 1,
        embedded: 0,
        without_sources: 0,
      });
      expect(scanned.debug_companions.paths).toEqual([]);
    },
  );

  it("does not treat a Java class file as a universal Mach-O", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-class-");
    await writeFile(join(root, "Main.class"), javaClassFile());
    const scanned = await inspect(root);
    expect(
      scanned.native_images.some(
        (image) => image.format === "mach-o-universal",
      ),
    ).toBe(false);
  });

  it("refuses a directory member whose bytes change after inventory", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-stable-");
    await writeFile(join(root, "notes.txt"), "plain text\n");
    const real = stableRead.impl;
    stableRead.impl = async (...args) => {
      if (real === undefined) throw new Error("missing stable read");
      const snapshot = await real(...args);
      if (args[0].endsWith("notes.txt"))
        return { bytes: snapshot.bytes, sha256: "ff".repeat(32) };
      return snapshot;
    };
    const reader = new ReleaseExposureReader();
    try {
      const result = await reader.inspect(
        { path: root },
        undefined,
        ignoreText,
      );
      if (result.ok) throw new Error("Expected a failed audit.");
      expect(result.error).toBeInstanceOf(AnalysisArtifactChangedError);
    } finally {
      stableRead.impl = real;
      await reader.close();
    }
  });
});

describe("ReleaseExposureReader limits", () => {
  it("counts sourcesContent nested past the old depth-8 walker", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-depth-");
    let map: unknown = {
      version: 3,
      file: "leaf.js",
      sources: ["leaf.js"],
      names: [],
      mappings: "",
      sourcesContent: ["const leaf = 1;\n"],
    };
    for (let depth = 0; depth < 9; depth += 1)
      map = {
        version: 3,
        sections: [{ offset: { line: 0, column: 0 }, map }],
      };
    await writeFile(join(root, "deep.js.map"), JSON.stringify(map));
    await writeFile(
      join(root, "trailing.js.map"),
      JSON.stringify({
        version: 3,
        file: "a.js",
        sources: ["a.js"],
        names: [],
        mappings: "",
        sourcesContent: [null, "ignored because it is past sources"],
      }),
    );
    const scanned = await inspect(root);
    expect(scanned.source_maps.embedded).toBe(1);
    expect(scanned.source_maps.without_sources).toBe(1);
  });

  it("caps reported limitations when many members cannot be read", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-cap-");
    for (let index = 0; index < 12; index += 1)
      await writeFile(join(root, `note-${String(index)}.txt`), "text\n");
    const real = stableRead.impl;
    stableRead.impl = async (...args) => {
      if (String(args[0]).endsWith(".txt"))
        throw new Error("unreadable member");
      if (real === undefined) throw new Error("missing stable read");
      return real(...args);
    };
    try {
      const scanned = await inspect(root);
      expect(scanned.limitations).toHaveLength(8);
    } finally {
      stableRead.impl = real;
    }
  });

  it("refuses a file whose inventory reports the bytes changed", async () => {
    const root = await createTestTempDirectory(
      "rea-release-exposure-integrity-",
    );
    const target = join(root, "app.bin");
    await writeFile(target, "stable\n");
    inventoryRead.impl = () => {
      throw new ArtifactReaderFailure(
        "integrity",
        `Artifact changed during inventory: ${target}`,
      );
    };
    const reader = new ReleaseExposureReader();
    try {
      const result = await reader.inspect(
        { path: target },
        undefined,
        ignoreText,
      );
      if (result.ok) throw new Error("Expected a failed audit.");
      expect(result.error).toBeInstanceOf(AnalysisArtifactChangedError);
    } finally {
      inventoryRead.impl = undefined;
      await reader.close();
    }
  });

  it("counts members past the package entry cap and marks coverage unknown", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-entries-");
    const files = [
      ...Array.from({ length: 4096 }, (_, index) => ({
        path: `f${String(index)}.bin`,
        bytes: Buffer.from("x"),
      })),
      { path: "hidden.js.map", bytes: Buffer.from("{not json") },
      { path: "secret.txt", bytes: Buffer.from("hello\n") },
    ];
    await writeFile(join(root, "app.dll"), dotnetBundleFixture(files).bytes);
    const scanned = await inspect(root);
    expect(scanned.coverage).toBe("unknown");
    expect(scanned.source_maps.skipped).toBeGreaterThan(0);
    expect(scanned.text_members.skipped).toBeGreaterThan(0);
    expect(scanned.omitted.map((item) => item.subject)).toEqual(
      expect.arrayContaining(["source maps", "text members"]),
    );
  }, 60_000);

  it("does not drop native images before the service samples them", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-natives-");
    for (let index = 0; index < 5; index += 1) {
      const elf = Buffer.alloc(64);
      elf[0] = 0x7f;
      elf[1] = 0x45;
      elf[2] = 0x4c;
      elf[3] = 0x46;
      await writeFile(join(root, `lib${String(index)}.so`), elf);
    }
    const scanned = await inspect(root);
    expect(scanned.native_images).toHaveLength(5);
    expect(
      scanned.omitted.some((item) => item.subject === "native images"),
    ).toBe(false);
  });

  it("locates a CodeView path on the PE image that contains it", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-pdb-");
    await writeFile(
      join(root, "app.exe"),
      pe(0x8664, 64, 0x0002, false, { pdbPath: "C:\\build\\app.pdb" }),
    );
    const scanned = await inspect(root);
    expect(scanned.pdb.paths).toContain("C:\\build\\app.pdb");
    expect(
      scanned.pdb.image_paths?.some((path) => path.endsWith("app.exe")),
    ).toBe(true);
  });
});

describe("ReleaseExposureReader package cleanup", () => {
  it("rejects a replaced inventoried package before listing and closes its reader", async () => {
    const root = await createTestTempDirectory(
      "rea-release-exposure-replaced-",
    );
    const archive = join(root, "app.asar");
    await writeFile(archive, sourceMapArchive());
    const actual = await vi.importActual<
      typeof import("./inventory/ArtifactInventory.js")
    >("./inventory/ArtifactInventory.js");
    let inventoried = false;
    inventoryRead.impl = async (...args) => {
      const inventory = await actual.inventoryArtifact(...args);
      await writeFile(
        archive,
        asarArchive([
          {
            name: "dist/app.js.map",
            bytes: Buffer.from(
              JSON.stringify({
                version: 3,
                sources: [],
                names: [],
                mappings: "",
              }),
            ),
          },
        ]),
      );
      inventoried = true;
      return inventory;
    };
    let created = 0;
    let listed = false;
    let closed = false;
    createdReaders.wrap = (source, path) => {
      if (path !== archive || !inventoried) return source;
      created += 1;
      const entries = source.entries.bind(source);
      source.entries = (...args) => {
        listed = true;
        return entries(...args);
      };
      const close = source.close.bind(source);
      source.close = async () => {
        closed = true;
        await close();
      };
      return source;
    };
    const reader = new ReleaseExposureReader();
    try {
      const result = await reader.inspect(
        { path: root },
        undefined,
        ignoreText,
      );
      if (result.ok) throw new Error("Expected a failed audit.");
      expect(result.error).toBeInstanceOf(AnalysisArtifactChangedError);
      expect(created).toBe(1);
      expect(listed).toBe(false);
      expect(closed).toBe(true);
    } finally {
      inventoryRead.impl = undefined;
      createdReaders.wrap = undefined;
      await reader.close();
    }
  });

  it.each([false, true])(
    "reports package cleanup failure and retains the scan or primary error (scan fails: %s)",
    async (scanFails) => {
      const root = await createTestTempDirectory("rea-release-exposure-close-");
      const archive = join(root, "app.asar");
      await writeFile(archive, sourceMapArchive());
      let created = 0;
      let closes = 0;
      createdReaders.wrap = (reader, path) => {
        if (!path.endsWith("app.asar")) return reader;
        created += 1;
        if (created === 1) return reader;
        const original = reader.close.bind(reader);
        let attempts = 0;
        reader.close = async () => {
          attempts += 1;
          closes += 1;
          if (attempts < 3) throw new Error(`close failed: ${path}`);
          await original();
        };
        return reader;
      };
      const reader = new ReleaseExposureReader();
      const primary = new AnalysisArtifactChangedError(
        "audit_release_exposure",
        archive,
        "scan target changed",
      );
      try {
        const result = await reader.inspect(
          { path: archive },
          undefined,
          scanFails
            ? () => {
                throw primary;
              }
            : ignoreText,
        );
        if (result.ok) throw new Error("Expected a failed audit.");
        expect(result.error.cleanupIncomplete).toBe(true);
        expect(result.error.cleanupResources).toContain(archive);
        if (scanFails)
          expect(result.error.diagnostics?.primary_error).toMatchObject({
            code: "artifact_changed",
            details: { reason: "scan target changed" },
          });
        else
          expect(result.error.diagnostics?.primary_error).toMatchObject({
            details: {
              diagnostics: { scan: { source_maps: { embedded: 1 } } },
            },
          });
        await expect(reader.close()).rejects.toSatisfy((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          const resources =
            typeof error === "object" &&
            error !== null &&
            "cleanupResources" in error
              ? (error as { cleanupResources: readonly string[] })
                  .cleanupResources
              : [];
          return (
            message.includes("app.asar") ||
            resources.some((resource) => resource.includes("app.asar"))
          );
        });
        expect(closes).toBeGreaterThan(1);
        await reader.close();
        expect(result.error.cleanupIncomplete).toBe(false);
      } finally {
        createdReaders.wrap = undefined;
        await reader.close().catch(() => undefined);
      }
    },
  );
});

describe("ReleaseExposureReader package allowances", () => {
  it("stops opening embedded packages after the container allowance", async () => {
    const root = await createTestTempDirectory(
      "rea-release-exposure-containers-",
    );
    for (let index = 0; index < 9; index += 1) {
      const bundle = dotnetBundleFixture([
        { path: "app.js", bytes: Buffer.from("console.log(1)\n") },
      ]);
      await writeFile(join(root, `app-${String(index)}.dll`), bundle.bytes);
    }
    const scanned = await inspect(root);
    expect(scanned.extractable.readable_members).toBe(8);
    expect(scanned.extractable.unreadable_members).toBeGreaterThan(0);
    expect(scanned.coverage).toBe("unknown");
    expect(scanned.limitations.length).toBeLessThanOrEqual(8);
    expect(scanned.omitted).toContainEqual(
      expect.objectContaining({ subject: "embedded package probes", count: 1 }),
    );
  });
});

describe("ReleaseExposureReader mixed maps and sibling paths", () => {
  it.each([false, true])(
    "retains embedded sources beside an external section (external first: %s)",
    async (externalFirst) => {
      const root = await createTestTempDirectory("rea-release-mixed-map-");
      const path = join(root, "app.js.map");
      const sections = [
        { map: JSON.parse(embeddedSourceMap().toString("utf8")) as unknown },
        { url: "external.map" },
      ];
      if (externalFirst) sections.reverse();
      await writeFile(
        path,
        JSON.stringify({
          version: 3,
          sections: sections.map((section, line) => ({
            offset: { line, column: 0 },
            ...section,
          })),
        }),
      );
      const scanned = await inspect(path);
      expect(scanned.source_maps).toMatchObject({
        embedded: 1,
        embedded_paths: [path],
        without_sources: 0,
        unparsed: 1,
      });
    },
  );

  it("keeps an embedded leaf beside a leaf with malformed mappings", async () => {
    const root = await createTestTempDirectory("rea-release-malformed-leaf-");
    const path = join(root, "app.js.map");
    await writeFile(
      path,
      JSON.stringify({
        version: 3,
        sections: [
          {
            offset: { line: 0, column: 0 },
            map: JSON.parse(embeddedSourceMap().toString("utf8")) as unknown,
          },
          {
            offset: { line: 1, column: 0 },
            map: { version: 3, sources: ["b.js"], names: [], mappings: "AA" },
          },
        ],
      }),
    );
    const scanned = await inspect(path);
    expect(scanned.source_maps).toMatchObject({
      embedded: 1,
      embedded_paths: [path],
      unparsed: 1,
    });
    expect(sourceMapSourcesStatus(scanned)).toBe("exposed");
  });

  it("does not expand sections past the decoder depth budget", async () => {
    const root = await createTestTempDirectory("rea-release-deep-map-");
    const path = join(root, "app.js.map");
    const leaf = JSON.parse(embeddedSourceMap().toString("utf8")) as unknown;
    let deep: unknown = leaf;
    for (let depth = 0; depth < 70; depth += 1)
      deep = {
        version: 3,
        sections: [{ offset: { line: 0, column: 0 }, map: deep }],
      };
    await writeFile(
      path,
      JSON.stringify({
        version: 3,
        sections: [
          { offset: { line: 0, column: 0 }, map: deep },
          { offset: { line: 1, column: 0 }, map: leaf },
        ],
      }),
    );
    const scanned = await inspect(path);
    expect(scanned.source_maps).toMatchObject({
      embedded: 1,
      embedded_paths: [path],
      unparsed: 1,
    });
    await writeFile(path, JSON.stringify(deep));
    expect((await inspect(path)).source_maps).toMatchObject({
      embedded: 0,
      unparsed: 1,
    });
  });

  it.skipIf(process.platform === "win32")(
    "preserves symlink/.. traversal for linker maps and named companions",
    async () => {
      const root = await createTestTempDirectory("rea-release-sibling-path-");
      await mkdir(join(root, "actual", "child"), { recursive: true });
      await symlink(join(root, "actual", "child"), join(root, "link"));
      await writeFile(join(root, "actual", "app"), "plain file");
      await writeFile(join(root, "actual", "app.map"), "Linker map\n");
      await writeFile(join(root, "actual", "app.pdb"), "debug companion");
      const parent = `${root}/link/..`;
      const scanned = await inspect(`${parent}/app`);
      expect(scanned.debug_companions).toEqual({
        paths: expect.arrayContaining([
          `${parent}/app.map`,
          `${parent}/app.pdb`,
        ]),
        skipped: 0,
      });
      expect(scanned.debug_companions.paths).toHaveLength(2);
    },
  );
});

describe("ReleaseExposureReader acquisition and sibling review regressions", () => {
  it.each(["external section", "decoder limit", "malformed JSON"])(
    "keeps a sibling map with an unsupported %s unresolved",
    async (scenario) => {
      const root = await createTestTempDirectory("rea-release-sibling-map-");
      let map: unknown = { version: 3, sources: [], mappings: "" };
      if (scenario === "external section")
        map = {
          version: 3,
          sections: [{ offset: { line: 0, column: 0 }, url: "external.map" }],
        };
      else if (scenario === "decoder limit")
        for (let depth = 0; depth < 66; depth += 1)
          map = {
            version: 3,
            sections: [{ offset: { line: 0, column: 0 }, map }],
          };
      await writeFile(
        join(root, "bundle.map"),
        scenario === "malformed JSON" ? "{broken" : JSON.stringify(map),
      );
      await writeFile(join(root, "app"), "plain file");
      const scanned = await inspect(join(root, "app"));
      expect(scanned.debug_companions).toEqual({ paths: [], skipped: 1 });
      expect(scanned.source_maps).toMatchObject({
        embedded: 0,
        without_sources: 0,
        unparsed: 0,
        skipped: 0,
        samples: [],
      });
    },
  );
  it("bounds package inventory acquisition before hashing members past the entry cap", async () => {
    const entryCap = 3;
    const root = await createTestTempDirectory(
      "rea-release-inventory-entries-",
    );
    const archive = join(root, "app.asar");
    await writeFile(
      archive,
      asarArchive(
        Array.from({ length: entryCap + 1 }, (_, index) => ({
          name: `member${String(index)}.bin`,
          bytes: Buffer.from("x"),
        })),
      ),
    );
    let opened = 0;
    const actual = await vi.importActual<
      typeof import("./inventory/ArtifactInventory.js")
    >("./inventory/ArtifactInventory.js");
    // Exercise real acquisition with a small cap instead of hashing 65,536
    // members; verify the production allowance is forwarded separately.
    const acquire = vi.fn<typeof actual.inventoryArtifact>((path, options) =>
      actual.inventoryArtifact(path, {
        ...options,
        acquisitionLimits: {
          maximumEntries: entryCap,
          maximumBytes: MAX_RELEASE_EXPOSURE_INVENTORY_BYTES,
        },
      }),
    );
    inventoryRead.impl = acquire;
    let inventoryReader: ArtifactReader | undefined;
    createdReaders.wrap = (source) => {
      if (inventoryReader !== undefined) return source;
      inventoryReader = source;
      const open = source.open.bind(source);
      source.open = (...args) => {
        opened += 1;
        return open(...args);
      };
      return source;
    };
    try {
      const scanned = await inspect(archive);
      expect(acquire).toHaveBeenCalledExactlyOnceWith(
        archive,
        expect.objectContaining({
          acquisitionLimits: {
            maximumEntries: MAX_RELEASE_EXPOSURE_INVENTORY_ENTRIES,
            maximumBytes: MAX_RELEASE_EXPOSURE_INVENTORY_BYTES,
          },
        }),
      );
      expect(opened).toBe(entryCap);
      expect(scanned.coverage).toBe("unknown");
      expect(scanned.limitations.join("\n")).toContain(
        "acquisition allowance exhausted",
      );
    } finally {
      inventoryRead.impl = undefined;
      createdReaders.wrap = undefined;
    }
  });

  it("bounds directory inventory bytes before opening an oversized member", async () => {
    const root = await createTestTempDirectory("rea-release-inventory-bytes-");
    await writeFile(join(root, "large.bin"), "");
    await truncate(
      join(root, "large.bin"),
      MAX_RELEASE_EXPOSURE_INVENTORY_BYTES + 1,
    );
    const reader = new ReleaseExposureReader();
    let opened = 0;
    createdReaders.wrap = (source) => {
      const open = source.open.bind(source);
      source.open = (...args) => {
        opened += 1;
        return open(...args);
      };
      return source;
    };
    try {
      const result = await reader.inspect(
        { path: root },
        undefined,
        ignoreText,
      );
      if (!result.ok) throw result.error;
      expect(opened).toBe(0);
      expect(result.value.coverage).toBe("unknown");
      expect(result.value.limitations.join("\n")).toContain(
        "acquisition allowance exhausted",
      );
    } finally {
      createdReaders.wrap = undefined;
      await reader.close();
    }
  });
});

describe("ReleaseExposureReader member allowances", () => {
  it.each(["unrelated.js.map", "unrelated.map"])(
    "keeps sibling source map %s out of the selected artifact's counts",
    async (name) => {
      const root = await createTestTempDirectory(
        "rea-release-exposure-sibling-",
      );
      await writeFile(join(root, "app"), "plain file");
      await writeFile(join(root, name), embeddedSourceMap());
      const scanned = await inspect(join(root, "app"));
      expect(scanned.source_maps).toMatchObject({
        embedded: 0,
        without_sources: 0,
        unparsed: 0,
        skipped: 0,
        samples: [],
      });
      expect(scanned.debug_companions).toEqual({ paths: [], skipped: 0 });
      expect(scanned.coverage).toBe("complete");
    },
  );

  it("keeps a later source map readable after many large binary members", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-budget-");
    const binary = Buffer.alloc(MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES);
    const oversizedScript = Buffer.alloc(
      MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES + 1,
      0x20,
    );
    await writeFile(
      join(root, "app.asar"),
      asarArchive([
        ...Array.from({ length: 160 }, (_, index) => ({
          name: `a${String(index)}.bin`,
          bytes: binary,
        })),
        { name: "b.js", bytes: oversizedScript },
        { name: "z.js.map", bytes: embeddedSourceMap() },
      ]),
    );
    const scanned = await inspect(join(root, "app.asar"));
    expect(scanned.source_maps).toMatchObject({ embedded: 1, skipped: 1 });
    expect(scanned.extractable.readable_members).toBe(162);
  }, 60_000);

  it("reports an oversized linker map as a debug companion wherever it ships", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-link-");
    const linkerMap = Buffer.alloc(
      MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES + 1,
      0x20,
    );
    linkerMap.write("Archive member included to satisfy reference\n");
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "app.map"), linkerMap);
    await writeFile(join(root, "bin", "app"), "not a package");
    const directory = await inspect(join(root, "bin"));
    expect(directory.debug_companions.paths).toEqual([
      expect.stringMatching(/bin\/app\.map$/u),
    ]);
    expect(directory.source_maps.skipped).toBe(0);

    const selected = await inspect(join(root, "bin", "app"));
    expect(selected.debug_companions.paths).toEqual([
      join(root, "bin", "app.map"),
    ]);
    expect(selected.source_maps.skipped).toBe(0);

    await writeFile(
      join(root, "app.asar"),
      asarArchive([{ name: "app.map", bytes: linkerMap }]),
    );
    const packaged = await inspect(join(root, "app.asar"));
    expect(packaged.debug_companions.paths).toEqual(["app.map"]);
    expect(packaged.source_maps.skipped).toBe(0);
  });

  it("leaves an oversized JSON .map undecided as both map kinds", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-json-");
    const map = Buffer.alloc(MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES + 1, 0x20);
    map.write('{"version":3,"sources":[]}');
    await writeFile(join(root, "bundle.map"), map);
    const scanned = await inspect(root);
    expect(scanned.debug_companions).toEqual({ paths: [], skipped: 1 });
    expect(scanned.source_maps.skipped).toBe(1);
    expect(scanned.text_members.skipped).toBe(1);
  });

  it("keeps whitespace-only prefixes of oversized maps unresolved", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-spaces-");
    await writeFile(
      join(root, "bundle.map"),
      Buffer.concat([
        Buffer.alloc(MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES, 0x20),
        embeddedSourceMap(),
      ]),
    );
    const scanned = await inspect(root);
    expect(scanned.source_maps.skipped).toBe(1);
    expect(scanned.debug_companions).toEqual({ paths: [], skipped: 1 });
  });

  it("does not spend the source-map allowance reading a JavaScript map past the count", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-count-");
    const map = embeddedSourceMap();
    for (let index = 0; index < 33; index += 1)
      await writeFile(join(root, `m${String(index)}.js.map`), map);
    const scanned = await inspect(root);
    expect(scanned.source_maps.embedded).toBe(32);
    expect(scanned.source_maps.skipped).toBe(1);
    expect(scanned.text_members.skipped).toBe(1);
  });
});

const bundled = async (
  files: readonly { path: string; bytes: Buffer }[],
): Promise<string> => {
  const root = await createTestTempDirectory("rea-release-exposure-bundle-");
  await writeFile(join(root, "app.dll"), dotnetBundleFixture(files).bytes);
  return root;
};

describe("ReleaseExposureReader text encodings", () => {
  const marker = "-----BEGIN PRIVATE KEY-----\n";

  const utf16 = (text: string, order: "le" | "be"): Buffer => {
    const little = Buffer.from(`\ufeff${text}`, "utf16le");
    return order === "le" ? little : Buffer.from(little).swap16();
  };

  const visited = async (path: string) => {
    const reader = new ReleaseExposureReader();
    try {
      const texts: string[] = [];
      const result = await reader.inspect({ path }, undefined, (text) => {
        texts.push(text);
      });
      if (!result.ok) throw result.error;
      return { texts, members: result.value.text_members };
    } finally {
      await reader.close();
    }
  };

  it.each(["le", "be"] as const)(
    "decodes UTF-16 %s members instead of scanning NUL-interleaved bytes",
    async (order) => {
      const root = await createTestTempDirectory("rea-release-exposure-text-");
      const plist = `<?xml version="1.0" encoding="UTF-16"?><plist><string>${marker}</string></plist>`;
      await writeFile(join(root, "Info.plist"), utf16(plist, order));
      await writeFile(join(root, "credentials"), utf16(marker, order));
      const { texts, members } = await visited(root);
      expect(texts.sort()).toEqual([marker, plist].sort());
      expect(members).toEqual({ scanned: 2, skipped: 0 });
    },
  );

  it("counts wide text it cannot decode as skipped, whatever the member declares", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-text-");
    const wide = Buffer.from(marker, "utf16le");
    await writeFile(join(root, "bomless.plist"), wide);
    await writeFile(join(root, "bomless.js"), wide);
    await writeFile(
      join(root, "wide.plist"),
      Buffer.concat([
        Buffer.from([0xff, 0xfe, 0, 0]),
        Buffer.from(
          [...marker].flatMap((char) => [char.charCodeAt(0), 0, 0, 0]),
        ),
      ]),
    );
    const { texts, members } = await visited(root);
    expect(texts).toEqual([]);
    expect(members).toEqual({ scanned: 0, skipped: 3 });
  });

  it("keeps a binary plist's ASCII strings in the scan", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-text-");
    const bytes = Buffer.concat([
      Buffer.from("bplist00"),
      Buffer.from([0]),
      Buffer.from(marker),
    ]);
    await writeFile(join(root, "Info.plist"), bytes);
    const { texts, members } = await visited(root);
    expect(texts.join("")).toContain(marker);
    expect(members).toEqual({ scanned: 1, skipped: 0 });
  });

  it("reads an inline map from a UTF-16 script", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-text-");
    const map = Buffer.from(
      JSON.stringify({
        version: 3,
        sources: ["src/app.ts"],
        sourcesContent: ["export {};"],
        mappings: "",
      }),
    ).toString("base64");
    await writeFile(
      join(root, "app.js"),
      utf16(
        `console.log(1);\n//# sourceMappingURL=data:application/json;base64,${map}\n`,
        "le",
      ),
    );
    const scanned = await inspect(root);
    expect(scanned.text_members).toEqual({ scanned: 1, skipped: 0 });
    expect(scanned.source_maps).toMatchObject({ embedded: 1, skipped: 0 });
  });
});

describe("ReleaseExposureReader text recognition", () => {
  const marker = "-----BEGIN PRIVATE KEY-----\n";

  it("scans a text file whose name is outside the extension list", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-text-");
    await writeFile(join(root, ".env.production"), marker);
    await writeFile(join(root, "server.key"), marker);
    await writeFile(join(root, "credentials"), marker);
    await writeFile(
      join(root, "image.dat"),
      Buffer.concat([Buffer.from("PNG"), Buffer.alloc(16)]),
    );
    await writeFile(join(root, "empty"), "");
    const scanned = await inspect(root);
    expect(scanned.textLocations.sort()).toEqual([
      join(root, ".env.production"),
      join(root, "credentials"),
      join(root, "server.key"),
    ]);
    expect(scanned.text_members).toEqual({ scanned: 3, skipped: 0 });
  });

  it("scans text past the probe prefix and counts text past the member allowance", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-text-");
    await writeFile(
      join(root, "long"),
      Buffer.alloc(MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES * 2, 0x20),
    );
    await writeFile(
      join(root, "oversized"),
      Buffer.alloc(MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES + 1, 0x20),
    );
    const scanned = await inspect(root);
    expect(scanned.textLocations).toEqual([join(root, "long")]);
    expect(scanned.text_members).toEqual({ scanned: 1, skipped: 1 });
  });

  it("recognizes a package member by content", async () => {
    const root = await bundled([
      { path: "credentials", bytes: Buffer.from(marker) },
      { path: "payload", bytes: Buffer.alloc(32) },
    ]);
    const scanned = await inspect(root);
    const host = join(root, "app.dll");
    expect(scanned.textLocations).toContain(`${host}/credentials`);
    expect(scanned.textLocations).not.toContain(`${host}/payload`);
  });

  it("leaves text undecided when a file could not be probed", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-text-");
    const opaque = join(root, "credentials");
    await writeFile(opaque, marker);
    const reader = new ReleaseExposureReader();
    let denied = 0;
    const real = stableRead.impl;
    stableRead.impl = async (...args) => {
      const [path] = args;
      if (path !== opaque && real !== undefined) return real(...args);
      denied += 1;
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    try {
      const result = await reader.inspect(
        { path: root },
        undefined,
        ignoreText,
      );
      if (!result.ok) throw result.error;
      expect(denied).toBe(1);
      expect(result.value.text_members.skipped).toBe(1);
    } finally {
      stableRead.impl = real;
      await reader.close();
    }
  });
});

describe("ReleaseExposureReader source spellings", () => {
  const decomposed = "caf\u0065\u0301";
  const key = "-----BEGIN PRIVATE KEY-----\n";

  it("reopens a decomposed ASAR member through its source spelling", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-nfd-");
    await writeFile(
      join(root, "app.asar"),
      asarArchive([
        { name: `${decomposed}.js.map`, bytes: embeddedSourceMap() },
        { name: `${decomposed}.txt`, bytes: Buffer.from(key) },
      ]),
    );
    const scanned = await inspect(root);
    expect(scanned.source_maps).toMatchObject({ embedded: 1, skipped: 0 });
    expect(sourceMapSourcesStatus(scanned)).toBe("exposed");
    expect(scanned.text_members.scanned).toBeGreaterThan(0);
    expect(scanned.text_members.skipped).toBe(0);
    expect(scanned.extractable).toMatchObject({ unreadable_members: 0 });
  });

  it("follows a percent-encoded decomposed map name in an ASAR", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-nfd-map-");
    await writeFile(
      join(root, "app.asar"),
      asarArchive([
        {
          name: "app.js",
          bytes: Buffer.from(
            "const value = 1;\n//# sourceMappingURL=cafe%CC%81.json\n",
          ),
        },
        { name: `${decomposed}.json`, bytes: embeddedSourceMap() },
      ]),
    );
    const scanned = await inspect(join(root, "app.asar"));
    expect(scanned.source_maps).toMatchObject({ embedded: 1, skipped: 0 });
    expect(scanned.source_maps.embedded_paths).toHaveLength(1);
    expect(sourceMapSourcesStatus(scanned)).toBe("exposed");
  });

  it("keeps a nested ASAR that was not expanded unknown", async () => {
    const root = await createTestTempDirectory("rea-release-nested-asar-");
    const inner = asarArchive([
      { name: "app.js.map", bytes: embeddedSourceMap() },
    ]);
    await writeFile(
      join(root, "app.asar"),
      asarArchive([{ name: "inner.asar", bytes: inner }]),
    );
    const scanned = await inspect(join(root, "app.asar"));
    expect(scanned.source_maps.embedded).toBe(0);
    expect(scanned.coverage).toBe("unknown");
    expect(sourceMapSourcesStatus(scanned)).toBe("unknown");
    expect(scanned.extractable.readable_members).toBe(1);
    expect(scanned.extractable.samples).toEqual([
      expect.stringContaining("inner.asar"),
    ]);
  });

  it("reopens a decomposed compressed .NET member", async () => {
    const stored = deflateRawSync(Buffer.from(key));
    const root = await createTestTempDirectory("rea-release-exposure-nfd-");
    await writeFile(
      join(root, "app.dll"),
      dotnetBundleFixture([
        {
          path: `${decomposed}.txt`,
          bytes: Buffer.from(key),
          compressed: true,
          storedBytes: stored,
        },
      ]).bytes,
    );
    const scanned = await inspect(join(root, "app.dll"));
    expect(scanned.text_members).toEqual({ scanned: 1, skipped: 0 });
    expect(scanned.extractable).toMatchObject({
      readable_members: 1,
      unreadable_members: 0,
    });
  });

  it("finds a compressed member whose source name differs from its path", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-src-");
    const file = join(root, "app.exe");
    await writeFile(
      file,
      cArchiveExecutable({
        carrier: "pe",
        layout: "2.1",
        pythonVersion: 310,
        members: [
          {
            name: "docs\\notes.txt",
            typeCode: "x",
            compress: true,
            payload: Buffer.from(key),
          },
        ],
      }),
    );
    const scanned = await inspect(file);
    expect(scanned.text_members).toEqual({ scanned: 1, skipped: 0 });
    expect(scanned.extractable).toMatchObject({
      readable_members: 1,
      unreadable_members: 0,
    });
  });

  it("reads a decomposed directory member by its source spelling", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-nfd-");
    await mkdir(join(root, "nested"));
    const name = join(root, "nested", `${decomposed}.txt`);
    await writeFile(name, key);
    const scanned = await inspect(root);
    expect(scanned.textLocations).toEqual([name]);
    expect(scanned.text_members).toEqual({ scanned: 1, skipped: 0 });
  });

  it("keeps symlink traversal in a selected directory path", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-link-");
    await mkdir(join(root, "real", "child"), { recursive: true });
    await writeFile(join(root, "real", "notes.txt"), key);
    await writeFile(join(root, "notes.txt"), "decoy\n");
    await symlink(join(root, "real", "child"), join(root, "link"));
    const selected = `${root}/link/..`;
    const scanned = await inspect(selected);
    expect(scanned.textLocations).toEqual([`${selected}/notes.txt`]);
    expect(scanned.text_members).toEqual({ scanned: 1, skipped: 0 });
  });
});

describe("ReleaseExposureReader package traversal coverage", () => {
  it("keeps a package reader's unknown coverage for an unexpanded member", async () => {
    const root = await bundled([
      { path: "notes.txt", bytes: Buffer.from("plain\n") },
    ]);
    const opaque = "An opaque archive was not expanded.";
    const actual = await vi.importActual<
      typeof import("./inventory/ArtifactInventory.js")
    >("./inventory/ArtifactInventory.js");
    let inventoried = false;
    inventoryRead.impl = async (...args) => {
      const inventory = await actual.inventoryArtifact(...args);
      inventoried = true;
      return inventory;
    };
    let reported = 0;
    createdReaders.wrap = (source) => {
      const entries = source.entries.bind(source);
      source.entries = (signal, options) => {
        // Inventory finished, so only this audit's own listing sees the gap.
        if (inventoried) {
          reported += 1;
          options?.onCoverage?.({ status: "unknown", limitations: [opaque] });
        }
        return entries(signal, options);
      };
      return source;
    };
    try {
      const scanned = await inspect(root);
      expect(reported).toBeGreaterThan(0);
      expect(scanned.coverage).toBe("unknown");
      expect(scanned.limitations).toContain(opaque);
    } finally {
      inventoryRead.impl = undefined;
      createdReaders.wrap = undefined;
    }
  });
});

describe("ReleaseExposureReader unexpanded packages", () => {
  it("does not count an oversized binary entry as a text member", async () => {
    const root = await bundled([
      {
        path: "Large.bin",
        bytes: Buffer.alloc(MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES + 1),
      },
    ]);
    const scanned = await inspect(root);
    expect(scanned.text_members.skipped).toBe(0);
    expect(scanned.omitted.map((item) => item.subject)).not.toContain(
      "text members",
    );
  });

  it("reports members skipped by an allowance as readable, not unreadable", async () => {
    const root = await bundled([
      {
        path: "Large.bin",
        bytes: Buffer.alloc(MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES + 1),
      },
      {
        path: "large.js",
        bytes: Buffer.alloc(MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES + 1, 0x20),
      },
    ]);
    const scanned = await inspect(root);
    expect(scanned.extractable).toMatchObject({
      readable_members: 2,
      unreadable_members: 0,
    });
    expect(scanned.text_members.skipped).toBe(1);
  });

  it("names the host file on every member location", async () => {
    const root = await bundled([
      { path: "notes.txt", bytes: Buffer.from("plain\n") },
      { path: "app.js.map", bytes: embeddedSourceMap() },
    ]);
    const scanned = await inspect(root);
    const host = join(root, "app.dll");
    expect(scanned.textLocations).toContain(`${host}/notes.txt`);
    expect(scanned.source_maps.embedded_paths).toEqual([`${host}/app.js.map`]);
    expect(scanned.extractable.samples).toContain(`${host}/notes.txt`);
    expect(scanned.native_images.map((image) => image.path)).toEqual([host]);
  });

  it("reports a debug companion stored in the package under its host", async () => {
    const root = await bundled([{ path: "App.pdb", bytes: Buffer.from("x") }]);
    const scanned = await inspect(root);
    expect(scanned.debug_companions.paths).toEqual([
      `${join(root, "app.dll")}/App.pdb`,
    ]);
  });

  it("leaves a PE too large to read undecided instead of absent", async () => {
    const image = Buffer.concat([
      pe(0x8664, 64, 0x0002, false, { pdbPath: "C:\\build\\app.pdb" }),
      Buffer.alloc(MAX_RELEASE_EXPOSURE_PACKAGED_PE_BYTES),
    ]);
    const root = await bundled([{ path: "Large.dll", bytes: image }]);
    const scanned = await inspect(root);
    expect(scanned.pdb.failed).toBe(1);
    expect(scanned.pdb.paths).toEqual([]);
    expect(scanned.limitations.join("\n")).toContain("Large.dll");
    expect(scanned.extractable.unreadable_members).toBe(0);
  });

  it("reads CodeView paths from a small packaged PE without charging text", async () => {
    const root = await bundled([
      {
        path: "Small.dll",
        bytes: pe(0x8664, 64, 0x0002, false, {
          pdbPath: "C:\\build\\small.pdb",
        }),
      },
    ]);
    const scanned = await inspect(root);
    expect(scanned.pdb.paths).toContain("C:\\build\\small.pdb");
    expect(scanned.pdb.image_paths).toEqual([
      `${join(root, "app.dll")}/Small.dll`,
    ]);
    expect(scanned.text_members.skipped).toBe(0);
  });

  it("keeps a packaged PE header beyond the probe unresolved", async () => {
    const original = pe(0x8664, 64, 0x0002, false, {
      pdbPath: "C:\\build\\delayed.pdb",
    });
    const image = Buffer.alloc(8192 + 512);
    original.copy(image);
    original.subarray(64, 512).copy(image, 8192);
    image.writeUInt32LE(8192, 60);
    const root = await bundled([{ path: "Delayed.dll", bytes: image }]);
    const scanned = await inspect(root);
    expect(scanned.pdb).toMatchObject({ failed: 1, paths: [] });
    expect(scanned.limitations.join("\n")).toContain("Delayed.dll");
  });
});

describe("ReleaseExposureReader unexpanded package PE reads", () => {
  it("retains each compressed duplicate entry across PE reads", async () => {
    const root = await createTestTempDirectory("rea-release-duplicate-pe-");
    const paths = ["C:\\build\\first.pdb", "C:\\build\\second.pdb"];
    const file = join(root, "app");
    await writeFile(
      file,
      cArchiveExecutable({
        layout: "2.1",
        pythonVersion: 310,
        members: paths.map((pdbPath) => ({
          name: "same.dll",
          typeCode: "b",
          compress: true,
          payload: Buffer.concat([
            pe(0x8664, 64, 0x0002, false, { pdbPath }),
            Buffer.alloc(4096),
          ]),
        })),
      }),
    );
    const scanned = await inspect(file);
    expect(scanned.pdb.paths).toEqual(paths);
    expect(scanned.pdb).toMatchObject({ examined: 2, failed: 0 });
    expect(scanned.extractable).toMatchObject({
      readable_members: 2,
      unreadable_members: 0,
    });
  });

  it("omits a packaged native image from the language readers visibly", async () => {
    const elf = Buffer.alloc(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46], 0);
    const root = await bundled([{ path: "libnative.so", bytes: elf }]);
    const scanned = await inspect(root);
    expect(scanned.omitted).toContainEqual(
      expect.objectContaining({
        subject: PACKAGED_NATIVE_IMAGES,
        count: 1,
      }),
    );
    expect(scanned.native_images.map((image) => image.path)).toEqual([
      join(root, "app.dll"),
    ]);
  });

  it("leaves member coverage unknown when a package cannot be listed", async () => {
    const root = await bundled([{ path: "app.js", bytes: Buffer.from("1") }]);
    createdReaders.wrap = (reader, path) => {
      if (path.endsWith("app.dll"))
        reader.entries = async function* () {
          yield* [];
          throw new Error("listing failed");
        };
      return reader;
    };
    try {
      const scanned = await inspect(root);
      expect(scanned.coverage).toBe("unknown");
      expect(scanned.extractable.unreadable_members).toBeGreaterThan(0);
    } finally {
      createdReaders.wrap = undefined;
    }
  });
});

describe("ReleaseExposureReader bounded listing and cleanup", () => {
  it("reports sibling close failure with the completed scan and retains its owner", async () => {
    const root = await createTestTempDirectory(
      "rea-release-exposure-sibling-close-",
    );
    const selected = join(root, "app.js");
    const companion = join(root, "app.pdb");
    await writeFile(selected, "const value = 1;");
    await writeFile(companion, "debug");
    const reader = new ReleaseExposureReader();
    directoryReads.closeHandles = [];
    directoryReads.failClose = true;
    try {
      const result = await reader.inspect(
        { path: selected },
        undefined,
        ignoreText,
      );
      if (result.ok) throw new Error("Expected a failed audit.");
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.cleanupResources).toContain(
        `directory beside the selected file: ${root}`,
      );
      expect(result.error.diagnostics?.primary_error).toMatchObject({
        details: {
          diagnostics: { scan: { debug_companions: { paths: [companion] } } },
        },
      });
      const handle = directoryReads.failedHandle;
      expect(handle).toBeDefined();
      await expect(reader.close()).rejects.toMatchObject({
        cleanupIncomplete: true,
      });
      directoryReads.failClose = false;
      await expect(reader.close()).rejects.toMatchObject({
        cleanupIncomplete: true,
      });
      // A failed Dir.close has no validity signal authorizing another native close.
      expect(directoryReads.closeHandles).toEqual([handle]);
      expect(result.error.cleanupIncomplete).toBe(true);
    } finally {
      directoryReads.failClose = false;
      directoryReads.failedHandle = undefined;
      directoryReads.closeHandles = [];
      await reader.close().catch(() => undefined);
    }
  });

  it("applies the caller's byte ceiling to on-disk PE reads", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-ceiling-");
    await writeFile(
      join(root, "app.exe"),
      pe(0x8664, 64, 0x0002, false, { pdbPath: "C:\\build\\app.pdb" }),
    );
    const reader = new ReleaseExposureReader();
    try {
      const result = await reader.inspect(
        { path: root, max_file_bytes: 64 },
        undefined,
        ignoreText,
      );
      if (!result.ok) throw result.error;
      expect(result.value.pdb).toMatchObject({ failed: 1, paths: [] });
      expect(result.value.coverage).toBe("unknown");
    } finally {
      await reader.close();
    }
  });

  it("stops reading a large parent directory at the sibling allowance", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-listing-");
    await Promise.all(
      Array.from({ length: 4100 }, (_, index) =>
        writeFile(join(root, `f${String(index)}.dat`), ""),
      ),
    );
    await writeFile(join(root, "app"), "selected");
    directoryReads.count = 0;
    const scanned = await inspect(join(root, "app"));
    expect(directoryReads.count).toBeLessThanOrEqual(4097);
    expect(scanned.debug_companions.skipped).toBe(1);
  });

  it.each([
    {
      name: "an embedded-package probe",
      selected: "lib.so",
      write: async (root: string) => {
        const elf = Buffer.alloc(64);
        elf.set([0x7f, 0x45, 0x4c, 0x46], 0);
        await writeFile(join(root, "lib.so"), elf);
      },
    },
    {
      name: "reading an oversized map prefix",
      selected: "bundle.map",
      write: async (root: string) => {
        await writeFile(
          join(root, "bundle.map"),
          Buffer.alloc(MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES + 1, 0x20),
        );
      },
    },
  ])(
    "retains a descriptor whose close failed after $name",
    async ({ selected, write }) => {
      const root = await createTestTempDirectory("rea-release-exposure-fd-");
      await write(root);
      const actual = await vi.importActual<
        typeof import("./inventory/ArtifactInventory.js")
      >("./inventory/ArtifactInventory.js");
      inventoryRead.impl = async (...args) => {
        const inventory = await actual.inventoryArtifact(...args);
        regularFiles.failClose = (path) => path.endsWith(selected);
        return inventory;
      };
      regularFiles.closes = 0;
      const reader = new ReleaseExposureReader();
      try {
        const result = await reader.inspect(
          { path: root },
          undefined,
          ignoreText,
        );
        if (!result.ok) throw result.error;
        regularFiles.failUntil = regularFiles.closes + 1;
        await expect(reader.close()).rejects.toSatisfy(
          (error: unknown) =>
            (error as { cleanupResources?: readonly string[] }).cleanupResources
              ?.join("\n")
              .includes(selected) === true,
        );
        await reader.close();
      } finally {
        inventoryRead.impl = undefined;
        regularFiles.failClose = undefined;
        regularFiles.failUntil = 1;
        await reader.close().catch(() => undefined);
      }
    },
  );
});

const embeddedSourceMap = (): Buffer =>
  Buffer.from(
    JSON.stringify({
      version: 3,
      file: "app.js",
      sources: ["app.js"],
      names: [],
      mappings: "",
      sourcesContent: [`export const secret = "${PLANTED_SOURCE}";\n`],
    }),
  );

const asarArchive = (
  files: readonly { readonly name: string; readonly bytes: Buffer }[],
): Buffer => {
  let offset = 0;
  const table: Record<string, { size: number; offset: string }> = {};
  for (const { name, bytes } of files) {
    table[name] = { size: bytes.length, offset: String(offset) };
    offset += bytes.length;
  }
  return Buffer.concat([
    asarHeaderBytes(JSON.stringify({ files: table })),
    ...files.map(({ bytes }) => bytes),
  ]);
};

const sourceMapArchive = (): Buffer => {
  const map = embeddedSourceMap();
  const notes = Buffer.from(
    `-----BEGIN PRIVATE KEY-----\n${PLANTED_KEY}\n-----END PRIVATE KEY-----\n`,
  );
  return Buffer.concat([
    asarHeaderBytes(
      JSON.stringify({
        files: {
          dist: {
            files: {
              "app.js.map": { size: map.length, offset: "0" },
              "notes.txt": { size: notes.length, offset: String(map.length) },
            },
          },
        },
      }),
    ),
    map,
    notes,
  ]);
};

describe("ReleaseExposureReader same-name members", () => {
  it("scans every same-name package member instead of the last one twice", async () => {
    const root = await createTestTempDirectory("rea-release-same-name-");
    const archive = join(root, "app.asar");
    await writeFile(
      archive,
      asarArchive([{ name: "config.txt", bytes: Buffer.from("x") }]),
    );
    const contents = new Map([
      ["first", "marker"],
      ["second", "harmless"],
    ]);
    createdReaders.wrap = (source) => {
      const list = source.entries.bind(source);
      source.entries = async function* (signal) {
        for await (const entry of list(signal)) {
          if (entry.path !== "config.txt") {
            yield entry;
            continue;
          }
          for (const adapterKey of contents.keys())
            yield { ...entry, adapterKey };
        }
      };
      source.open = (entry) =>
        Promise.resolve(Readable.from([contents.get(entry.adapterKey) ?? ""]));
      return source;
    };
    try {
      const reader = new ReleaseExposureReader();
      const texts: string[] = [];
      const result = await reader.inspect(
        { path: archive },
        undefined,
        (text) => {
          texts.push(text);
        },
      );
      await reader.close();
      if (!result.ok) throw result.error;
      expect(texts).toEqual(expect.arrayContaining(["harmless", "marker"]));
    } finally {
      createdReaders.wrap = undefined;
    }
  });
});

describe("ReleaseExposureReader member identity", () => {
  it("reads a compressed same-name member after an empty stored one", async () => {
    const root = await createTestTempDirectory("rea-release-empty-first-");
    const file = join(root, "app");
    await writeFile(
      file,
      cArchiveExecutable({
        layout: "2.1",
        pythonVersion: 310,
        members: [
          {
            name: "config.txt",
            typeCode: "x",
            compress: false,
            payload: Buffer.alloc(0),
          },
          {
            name: "config.txt",
            typeCode: "x",
            compress: true,
            payload: Buffer.from("credential-marker"),
          },
        ],
      }),
    );
    const reader = new ReleaseExposureReader();
    const texts: string[] = [];
    const result = await reader.inspect({ path: file }, undefined, (text) => {
      texts.push(text);
    });
    await reader.close();
    if (!result.ok) throw result.error;
    expect(texts).toContain("credential-marker");
  });

  it.each([
    ["app.js", "debug.json", { embedded: 1, skipped: 0 }],
    ["z.js", "a.json", { embedded: 0, skipped: 1 }],
  ])(
    "follows %s to a differently named local map %s",
    async (script, map, expected) => {
      const root = await createTestTempDirectory("rea-release-named-map-");
      await writeFile(
        join(root, script),
        `const value = 1;\n//# sourceMappingURL=${map}\n`,
      );
      await writeFile(join(root, map), embeddedSourceMap());
      const scanned = await inspect(root);
      expect(scanned.source_maps).toMatchObject(expected);
    },
  );

  it("counts a declared map target that never ships as skipped", async () => {
    const root = await createTestTempDirectory("rea-release-missing-map-");
    await writeFile(
      join(root, "app.js"),
      "const value = 1;\n//# sourceMappingURL=debug.json\n",
    );
    const scanned = await inspect(root);
    expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 1 });
  });

  it.each([
    ["app.js", "debug.json", { embedded: 1, skipped: 0 }],
    ["z.js", "a.json", { embedded: 0, skipped: 1 }],
  ])(
    "follows %s through a file: URL to the inventoried member %s",
    async (script, map, expected) => {
      const root = await createTestTempDirectory("rea-release-file-url-map-");
      const url = pathToFileURL(join(root, map)).href;
      await writeFile(
        join(root, script),
        `const value = 1;\n//# sourceMappingURL=${url}\n`,
      );
      await writeFile(join(root, map), embeddedSourceMap());
      const scanned = await inspect(root);
      expect(scanned.source_maps).toMatchObject(expected);
    },
  );

  it.each(["debug.json", "debug.js.map"])(
    "counts a file: URL to %s outside the installation as skipped",
    async (map) => {
      const root = await createTestTempDirectory("rea-release-file-url-gone-");
      const outside = await createTestTempDirectory(
        "rea-release-file-url-out-",
      );
      const url = pathToFileURL(join(outside, map)).href;
      await writeFile(
        join(root, "app.js"),
        `const value = 1;\n//# sourceMappingURL=${url}\n`,
      );
      const scanned = await inspect(root);
      expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 1 });
    },
  );

  it("counts a malformed file: URL as skipped and ignores a remote map", async () => {
    const root = await createTestTempDirectory("rea-release-file-url-bad-");
    await writeFile(
      join(root, "bad.js"),
      "const value = 1;\n//# sourceMappingURL=file:///release%2Fdebug.json\n",
    );
    await writeFile(
      join(root, "remote.js"),
      "const value = 2;\n//# sourceMappingURL=https://example.com/debug.json\n",
    );
    const scanned = await inspect(root);
    expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 1 });
  });
});

const sourceMapSourcesStatus = (scan: ReleaseExposureScan) =>
  assembleReleaseExposureReport(scan, {
    electron_family: "not_electron",
    fuse_images: [],
    go_images: [],
    rust_images: [],
    credential_markers: { hits: [], omitted_hits: 0 },
  }).checks.find((check) => check.id === "javascript.source_map_sources")
    ?.status;

const inspect = async (path: string) => {
  const reader = new ReleaseExposureReader();
  try {
    const textLocations: string[] = [];
    const result = await reader.inspect({ path }, undefined, (_, location) => {
      textLocations.push(location);
    });
    if (!result.ok) throw result.error;
    return { ...result.value, textLocations };
  } finally {
    await reader.close();
  }
};
