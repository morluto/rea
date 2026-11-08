import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { deflateRawSync, deflateSync } from "node:zlib";
import type { Dirent } from "node:fs";
import { mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { AnalysisArtifactChangedError } from "../domain/analysisErrorCore.js";
import { pe } from "../domain/binaryTarget.fixture.js";
import { nodeSeaElf } from "./nodeSea/NodeSea.fixture.js";
import {
  bunModuleGraphPayload,
  bunPrefixedPayload,
  elfBunSection,
} from "./bun/BunStandalone.fixture.js";
import { dotnetBundleFixture } from "./dotnet/DotnetBundle.fixture.js";
import { cArchiveExecutable } from "./pyinstaller/CArchive.fixture.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { asarHeaderBytes } from "../../tests/fixtures/asarHeader.js";
import { binaryPlistObjectTable } from "../../tests/fixtures/binaryPlistObjectTable.js";
import { javaClassFile } from "../../tests/fixtures/javaClassFile.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { universalMacho } from "../../tests/fixtures/universalMacho.js";
import { windowsNativeArtifactFixture } from "../../tests/fixtures/windowsNativeArtifact.js";
import {
  ArtifactReaderFailure,
  type ArtifactEntry,
  type ArtifactReader,
} from "./ArtifactReader.js";
import {
  assembleReleaseExposureReport,
  MAX_RELEASE_EXPOSURE_INVENTORY_BYTES,
  MAX_RELEASE_EXPOSURE_INVENTORY_ENTRIES,
  MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES,
  MAX_RELEASE_EXPOSURE_PACKAGED_PE_BYTES,
  MAX_RELEASE_EXPOSURE_MAP_TARGET_BYTES,
  MAX_RELEASE_EXPOSURE_SCRIPT_TARGET_BYTES,
  MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES,
  MAX_RELEASE_EXPOSURE_SOURCE_MAPS,
  MAX_RELEASE_EXPOSURE_TEXT_BYTES,
  MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES,
  PACKAGED_NATIVE_IMAGES,
  type ReleaseExposureScan,
} from "../domain/releaseExposure.js";
import { HTML_INLINE_SCRIPT_LOCATION_LIMIT } from "../domain/javascript/htmlArtifactReferences.js";
import { ReleaseExposureReader } from "./ReleaseExposureReader.js";
import { AsarArtifactReader } from "./AsarArtifactReader.js";
import type { AsarHeaderAdmission } from "../config/asarHeaderAdmission.js";

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
          typeof import("./inventory/ArtifactInventory.js").inventoryArtifactInScope
        >
      ) => ReturnType<
        typeof import("./inventory/ArtifactInventory.js").inventoryArtifactInScope
      >),
}));

vi.mock("./inventory/ArtifactInventory.js", async () => {
  const actual = await vi.importActual<
    typeof import("./inventory/ArtifactInventory.js")
  >("./inventory/ArtifactInventory.js");
  return {
    ...actual,
    inventoryArtifactInScope: (
      ...args: Parameters<typeof actual.inventoryArtifactInScope>
    ) => (inventoryRead.impl ?? actual.inventoryArtifactInScope)(...args),
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

describe("ReleaseExposureReader unpacked ASAR members", () => {
  it("rejects an unpacked ASAR companion replaced after inventory", async () => {
    const root = await createTestTempDirectory(
      "rea-release-exposure-unpacked-",
    );
    const archive = join(root, "app.asar");
    const companion = join(`${archive}.unpacked`, "dist", "notes.txt");
    const notes = Buffer.from(
      `-----BEGIN PRIVATE KEY-----\n${PLANTED_KEY}\n-----END PRIVATE KEY-----\n`,
    );
    await writeFile(
      archive,
      asarHeaderBytes(
        JSON.stringify({
          files: {
            dist: {
              files: { "notes.txt": { size: notes.length, unpacked: true } },
            },
          },
        }),
      ),
    );
    await mkdir(dirname(companion), { recursive: true });
    await writeFile(companion, notes);
    expect((await inspect(archive)).textLocations).toContain("dist/notes.txt");

    const actual = await vi.importActual<
      typeof import("./inventory/ArtifactInventory.js")
    >("./inventory/ArtifactInventory.js");
    inventoryRead.impl = async (...args) => {
      const inventory = await actual.inventoryArtifactInScope(...args);
      await writeFile(companion, Buffer.alloc(notes.length, 0x61));
      return inventory;
    };
    const reader = new ReleaseExposureReader();
    try {
      const result = await reader.inspect(
        { path: archive },
        undefined,
        ignoreText,
      );
      if (result.ok) throw new Error("Expected a failed audit.");
      expect(result.error).toBeInstanceOf(AnalysisArtifactChangedError);
      expect(result.error.message).toContain(
        "ASAR member changed before interpretation: dist/notes.txt",
      );
    } finally {
      inventoryRead.impl = undefined;
      await reader.close();
    }
  });
  it("does not read an oversized unpacked ASAR companion past its allowance", async () => {
    const root = await createTestTempDirectory(
      "rea-release-exposure-unpacked-large-",
    );
    const archive = join(root, "app.asar");
    const size = 8 * 1024 * 1024;
    const companion = join(`${archive}.unpacked`, "native", "module.bin");
    await writeFile(
      archive,
      asarHeaderBytes(
        JSON.stringify({
          files: {
            native: {
              files: { "module.bin": { size, unpacked: true } },
            },
          },
        }),
      ),
    );
    await mkdir(dirname(companion), { recursive: true });
    await writeFile(companion, Buffer.alloc(size));

    // Count the bytes each scan read pulls once inventory has hashed the
    // companion, by handing the reader a stream that tallies what it consumes.
    const actual = await vi.importActual<
      typeof import("./inventory/ArtifactInventory.js")
    >("./inventory/ArtifactInventory.js");
    let scanning = false;
    inventoryRead.impl = async (...args) => {
      const inventory = await actual.inventoryArtifactInScope(...args);
      scanning = true;
      return inventory;
    };
    const pulled: number[] = [];
    const open = AsarArtifactReader.prototype.open;
    const spy = vi
      .spyOn(AsarArtifactReader.prototype, "open")
      .mockImplementation(async function (this: AsarArtifactReader, ...args) {
        const stream = await open.apply(this, args);
        if (!scanning) return stream;
        const index = pulled.push(0) - 1;
        const counted = Readable.from(
          (async function* () {
            for await (const chunk of stream) {
              pulled[index] = (pulled[index] ?? 0) + (chunk as Buffer).length;
              yield chunk as Buffer;
            }
          })(),
          { objectMode: false },
        );
        counted.once("close", () => stream.destroy());
        return counted;
      });
    const reader = new ReleaseExposureReader();
    try {
      const result = await reader.inspect(
        { path: archive },
        undefined,
        ignoreText,
      );
      if (!result.ok) throw result.error;
      expect(pulled.length).toBeGreaterThan(0);
      for (const bytes of pulled) expect(bytes).toBeLessThan(1024 * 1024);
    } finally {
      inventoryRead.impl = undefined;
      spy.mockRestore();
      await reader.close();
    }
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
      const inventory = await actual.inventoryArtifactInScope(...args);
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

  it.each([
    {
      name: "a truncated mapping segment",
      root: {},
      second: { offset: { line: 1, column: 0 }, map: malformedLeaf("AA") },
    },
    {
      name: "a schema-invalid mappings string",
      root: {},
      second: { offset: { line: 1, column: 0 }, map: malformedLeaf("!") },
    },
    {
      name: "a schema-invalid section offset",
      root: {},
      second: { offset: { line: "1" }, map: malformedLeaf("AAAA") },
    },
    {
      name: "a schema-invalid root field",
      root: { file: 5 },
      second: { offset: { line: 1, column: 0 }, map: malformedLeaf("AAAA") },
    },
  ])(
    "keeps an embedded leaf beside $name",
    async ({ root: fields, second }) => {
      const root = await createTestTempDirectory("rea-release-malformed-leaf-");
      const path = join(root, "app.js.map");
      await writeFile(
        path,
        JSON.stringify({
          version: 3,
          ...fields,
          sections: [
            {
              offset: { line: 0, column: 0 },
              map: JSON.parse(embeddedSourceMap().toString("utf8")) as unknown,
            },
            second,
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
    },
  );

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

  it.skipIf(process.platform === "win32")(
    "names a symlinked sibling companion without following it",
    async () => {
      const root = await createTestTempDirectory("rea-release-sibling-link-");
      await writeFile(join(root, "app"), "plain file");
      await writeFile(join(root, "symbols"), "debug companion");
      await symlink(join(root, "symbols"), join(root, "app.pdb"));
      await symlink(join(root, "missing"), join(root, "app.debug"));
      await symlink(join(root, "app"), join(root, "plain-link"));
      const expected = [join(root, "app.debug"), join(root, "app.pdb")];
      const selected = await inspect(join(root, "app"));
      expect([...selected.debug_companions.paths].sort()).toEqual(expected);
      expect(selected.debug_companions.skipped).toBe(0);
      const directory = await inspect(root);
      expect([...directory.debug_companions.paths].sort()).toEqual(expected);
    },
  );
});

describe("ReleaseExposureReader generic map links", () => {
  it.skipIf(process.platform === "win32")(
    "keeps debug companion coverage unresolved for a generic .map link",
    async () => {
      const root = await createTestTempDirectory("rea-release-map-link-");
      await writeFile(join(root, "payload"), "not a map\n");
      await symlink("payload", join(root, "symbols.map"));
      const scanned = await inspect(root);
      expect(scanned.debug_companions.skipped).toBe(1);
      expect(debugCompanionsStatus(scanned)).toBe("unknown");
      expect(scanned.source_maps.skipped).toBe(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps debug companion coverage unresolved for a .map link beside a selected file",
    async () => {
      const root = await createTestTempDirectory("rea-release-sibling-link-");
      await writeFile(join(root, "app"), "plain file");
      await writeFile(join(root, "payload"), "not a map\n");
      await symlink("payload", join(root, "symbols.map"));
      await symlink("payload", join(root, "app.js.map"));
      const scanned = await inspect(join(root, "app"));
      expect(scanned.debug_companions).toEqual({ paths: [], skipped: 1 });
      expect(debugCompanionsStatus(scanned)).toBe("unknown");
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps a declared .map link beside a selected script a source map",
    async () => {
      const root = await createTestTempDirectory("rea-release-declared-link-");
      await writeFile(
        join(root, "app.js"),
        "const value = 1;\n//# sourceMappingURL=symbols.map\n",
      );
      await writeFile(join(root, "payload"), "not a map\n");
      await symlink("payload", join(root, "symbols.map"));
      const scanned = await inspect(join(root, "app.js"));
      expect(scanned.debug_companions).toEqual({ paths: [], skipped: 0 });
      expect(scanned.source_maps.skipped).toBe(1);
    },
  );

  it.skipIf(process.platform === "win32")(
    "leaves debug companions alone for a JavaScript map link",
    async () => {
      const root = await createTestTempDirectory("rea-release-map-link-");
      await writeFile(join(root, "payload"), "{}");
      await symlink("payload", join(root, "app.js.map"));
      const scanned = await inspect(root);
      expect(scanned.debug_companions.skipped).toBe(0);
    },
  );
});

describe("ReleaseExposureReader sibling map identity", () => {
  it("does not report a sibling .map a selected page loads as a script as a linker map", async () => {
    const root = await createTestTempDirectory("rea-release-sibling-script-");
    await writeFile(
      join(root, "index.html"),
      '<html><script src="boot.map"></script></html>',
    );
    await writeFile(join(root, "boot.map"), "console.log('boot');\n");
    const scanned = await inspect(join(root, "index.html"));
    expect(scanned.debug_companions).toEqual({ paths: [], skipped: 0 });
    expect(debugCompanionsStatus(scanned)).not.toBe("exposed");
    expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 1 });
  });

  it("does not report a native image beside a selected file as a linker map", async () => {
    const root = await createTestTempDirectory("rea-release-sibling-native-");
    const elf = Buffer.alloc(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46], 0);
    await writeFile(join(root, "release.map"), elf);
    await writeFile(join(root, "app"), "plain file");
    const scanned = await inspect(join(root, "app"));
    expect(scanned.debug_companions).toEqual({ paths: [], skipped: 0 });
    expect(debugCompanionsStatus(scanned)).not.toBe("exposed");
  });
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
    const acquire = vi.fn<typeof actual.inventoryArtifactInScope>(
      (path, options) =>
        actual.inventoryArtifactInScope(path, {
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

describe("ReleaseExposureReader native member names", () => {
  it("inspects a packaged PE whose name reads as text", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-name-");
    await writeFile(
      join(root, "app.asar"),
      asarArchive([
        {
          name: "payload.json",
          bytes: pe(0x8664, 64, 0x0002, false, {
            pdbPath: "C:\\build\\named.pdb",
          }),
        },
      ]),
    );
    const scanned = await inspect(root);
    expect(scanned.pdb.paths).toContain("C:\\build\\named.pdb");
    expect(scanned.omitted.map(({ subject }) => subject)).toContain(
      "packaged native images",
    );
  });
});

describe("ReleaseExposureReader nested packages in a host", () => {
  it("leaves coverage unknown for an ASAR a PyInstaller host carries", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-nest-");
    await writeFile(
      join(root, "app.exe"),
      cArchiveExecutable({
        carrier: "pe",
        layout: "2.1",
        pythonVersion: 310,
        members: [
          {
            name: "resources",
            typeCode: "x",
            compress: true,
            payload: asarArchive([
              { name: "app.js.map", bytes: Buffer.from("{}") },
            ]),
          },
        ],
      }),
    );
    const scanned = await inspect(root);
    expect(scanned.coverage).toBe("unknown");
    expect(scanned.extractable.formats).toContain("asar");
    expect(scanned.limitations.join("\n")).toContain("was not expanded");
  });

  it.each([
    [
      "PyInstaller",
      cArchiveExecutable({
        carrier: "elf",
        layout: "2.1",
        pythonVersion: 310,
        members: [
          {
            name: "app.js.map",
            typeCode: "x",
            compress: true,
            payload: embeddedSourceMap(),
          },
        ],
      }),
    ],
    [
      "Bun",
      elfBunSection(
        bunPrefixedPayload(
          bunModuleGraphPayload({
            modules: [
              {
                name: "/$bunfs/root/main.js",
                contents: Buffer.from("run();\n"),
                sourcemap: embeddedSourceMap(),
              },
            ],
          }),
        ),
      ),
    ],
    ["Node SEA", nodeSeaElf()],
    [
      ".NET",
      dotnetBundleFixture([{ path: "app.js.map", bytes: embeddedSourceMap() }])
        .bytes,
    ],
  ])("keeps a %s executable in an ASAR unknown", async (_, executable) => {
    const root = await createTestTempDirectory("rea-release-nested-exe-");
    await writeFile(
      join(root, "app.asar"),
      asarArchive([{ name: "tool", bytes: executable }]),
    );
    const scanned = await inspect(join(root, "app.asar"));
    expect(scanned.source_maps.embedded).toBe(0);
    expect(scanned.coverage).toBe("unknown");
    expect(sourceMapSourcesStatus(scanned)).toBe("unknown");
    expect(scanned.limitations.join("\n")).toContain("was not expanded");
    expect(scanned.extractable.readable_members).toBe(1);
  });

  it.each([
    ["an inflated", false, "complete"],
    ["a corrupt", true, "unknown"],
  ])(
    "settles coverage for %s compressed text member of a host",
    async (_, corrupt, coverage) => {
      const root = await createTestTempDirectory("rea-release-exposure-zlib-");
      const payload = Buffer.from('{"name":"app"}\n');
      const executable = cArchiveExecutable({
        carrier: "pe",
        layout: "2.1",
        pythonVersion: 310,
        members: [
          { name: "payload.json", typeCode: "x", compress: true, payload },
        ],
      });
      // Past the two-byte zlib header, 0xff opens a block of reserved type 3.
      const stream = executable.indexOf(deflateSync(payload));
      if (corrupt) executable[stream + 2] = 0xff;
      await writeFile(join(root, "app.exe"), executable);
      const scanned = await inspect(root);
      expect(scanned.coverage).toBe(coverage);
      expect(scanned.text_members.skipped).toBe(corrupt ? 1 : 0);
    },
  );

  it("keeps coverage complete past a packaged image with no package", async () => {
    const root = await createTestTempDirectory("rea-release-plain-exe-");
    const elf = Buffer.alloc(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46], 0);
    await writeFile(
      join(root, "app.asar"),
      asarArchive([{ name: "addon.node", bytes: elf }]),
    );
    const scanned = await inspect(join(root, "app.asar"));
    expect(scanned.coverage).toBe("complete");
    expect(sourceMapSourcesStatus(scanned)).toBe("not_observed");
  });

  it("keeps a packaged image past the byte allowance unknown", async () => {
    const root = await createTestTempDirectory("rea-release-large-exe-");
    const elf = Buffer.alloc(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46], 0);
    await writeFile(
      join(root, "app.asar"),
      asarArchive([
        { name: "first.node", bytes: elf },
        { name: "second.node", bytes: elf },
      ]),
    );
    const reader = new ReleaseExposureReader();
    try {
      const result = await reader.inspect(
        { path: root, max_file_bytes: 96 },
        undefined,
        () => undefined,
      );
      if (!result.ok) throw result.error;
      expect(result.value.coverage).toBe("unknown");
      expect(result.value.omitted).toContainEqual(
        expect.objectContaining({ subject: "embedded package probes" }),
      );
    } finally {
      await reader.close();
    }
  });
});

describe("ReleaseExposureReader source-map count", () => {
  it.each([
    [
      "dotnet-bundle",
      (bytes: Buffer, paths: readonly string[]): Buffer =>
        dotnetBundleFixture(
          paths.map((path) => ({ path, bytes, compressed: true })),
        ).bytes,
    ],
    [
      "pyinstaller-carchive",
      (bytes: Buffer, paths: readonly string[]): Buffer =>
        cArchiveExecutable({
          carrier: "pe",
          layout: "2.1",
          pythonVersion: 310,
          members: paths.map((name) => ({
            name,
            typeCode: "x",
            compress: true,
            payload: bytes,
          })),
        }),
    ],
  ])(
    "charges an oversized %s map to the map count before opening it",
    async (_format, archive) => {
      const root = await createTestTempDirectory("rea-release-exposure-over-");
      const count = MAX_RELEASE_EXPOSURE_SOURCE_MAPS + 8;
      const oversized = Buffer.alloc(
        MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES + 1,
        0x20,
      );
      const paths = Array.from(
        { length: count },
        (_, index) => `m${String(index)}.js.map`,
      );
      const target = join(root, "app.dll");
      await writeFile(target, archive(oversized, paths));
      let opened = 0;
      createdReaders.wrap = (reader, path) => {
        if (path !== target) return reader;
        const open = reader.open.bind(reader);
        reader.open = (entry, signal) => {
          if (entry.path.endsWith(".js.map")) opened += 1;
          return open(entry, signal);
        };
        return reader;
      };
      try {
        const scanned = await inspect(root);
        expect(opened).toBe(MAX_RELEASE_EXPOSURE_SOURCE_MAPS);
        expect(scanned.source_maps).toMatchObject({
          embedded: 0,
          skipped: count,
        });
        expect(scanned.text_members.skipped).toBe(count);
      } finally {
        createdReaders.wrap = undefined;
      }
    },
  );

  it("keeps a linker map's outcome past the count once oversized maps use it", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-spent-");
    const oversized = Buffer.alloc(
      MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES + 1,
      0x20,
    );
    oversized.write("Archive member included to satisfy reference\n");
    await writeFile(
      join(root, "app.dll"),
      dotnetBundleFixture(
        Array.from(
          { length: MAX_RELEASE_EXPOSURE_SOURCE_MAPS + 1 },
          (_, index) => ({
            path: `m${String(index)}.map`,
            bytes: oversized,
            compressed: true,
          }),
        ),
      ).bytes,
    );
    const scanned = await inspect(root);
    expect(scanned.debug_companions.paths).toHaveLength(
      MAX_RELEASE_EXPOSURE_SOURCE_MAPS + 1,
    );
    expect(scanned.source_maps.skipped).toBe(0);
  });
});

describe("ReleaseExposureReader sibling map allowance", () => {
  const countSiblingReads = async (
    run: () => Promise<ReleaseExposureScan>,
  ): Promise<{ scanned: ReleaseExposureScan; budgets: number[] }> => {
    const budgets: number[] = [];
    const real = stableRead.impl;
    stableRead.impl = async (...args) => {
      if (real === undefined) throw new Error("stable read is not installed");
      if (args[0].endsWith(".map")) budgets.push(args[1]);
      return real(...args);
    };
    try {
      return { scanned: await run(), budgets };
    } finally {
      stableRead.impl = real;
    }
  };

  it("stops full sibling map reads at the map count", async () => {
    const root = await createTestTempDirectory("rea-release-sibling-budget-");
    const extra = 3;
    const count = MAX_RELEASE_EXPOSURE_SOURCE_MAPS + extra;
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        writeFile(
          join(root, `s${String(index)}.map`),
          JSON.stringify({ version: 3, sources: [], mappings: "" }),
        ),
      ),
    );
    await writeFile(join(root, "app"), "plain file");
    const { scanned, budgets } = await countSiblingReads(() =>
      inspect(join(root, "app")),
    );
    expect(budgets).toHaveLength(count);
    expect(
      budgets.filter(
        (bytes) => bytes === MAX_RELEASE_EXPOSURE_SOURCE_MAP_BYTES,
      ),
    ).toHaveLength(MAX_RELEASE_EXPOSURE_SOURCE_MAPS);
    expect(
      budgets.filter(
        (bytes) => bytes === MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES,
      ),
    ).toHaveLength(extra);
    expect(scanned.debug_companions).toEqual({ paths: [], skipped: extra });
    expect(scanned.source_maps).toMatchObject({ skipped: 0, samples: [] });
  });

  it("settles sibling maps from the probe once the selected file spends the count", async () => {
    const root = await createTestTempDirectory("rea-release-sibling-spent-");
    const map = Buffer.from(
      JSON.stringify({ version: 3, sources: [], mappings: "" }),
    );
    await writeFile(
      join(root, "app.dll"),
      dotnetBundleFixture(
        Array.from(
          { length: MAX_RELEASE_EXPOSURE_SOURCE_MAPS },
          (_, index) => ({
            path: `m${String(index)}.js.map`,
            bytes: map,
            compressed: true,
          }),
        ),
      ).bytes,
    );
    const pastProbe = MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES + 1;
    const linker = "Archive member included to satisfy reference\n";
    await writeFile(join(root, "short-linker.map"), linker);
    await writeFile(
      join(root, "long-linker.map"),
      linker.padEnd(pastProbe, " "),
    );
    await writeFile(join(root, "short-json.map"), map);
    await writeFile(join(root, "long-json.map"), "{".padEnd(pastProbe, " "));
    const { scanned, budgets } = await countSiblingReads(() =>
      inspect(join(root, "app.dll")),
    );
    expect(budgets).toEqual(
      Array.from({ length: 4 }, () => MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES),
    );
    expect([...scanned.debug_companions.paths].sort()).toEqual([
      join(root, "long-linker.map"),
      join(root, "short-linker.map"),
    ]);
    expect(scanned.debug_companions.skipped).toBe(2);
    expect(scanned.source_maps.skipped).toBe(0);
  });
});

const bundled = async (
  files: readonly { path: string; bytes: Buffer }[],
): Promise<string> => {
  const root = await createTestTempDirectory("rea-release-exposure-bundle-");
  await writeFile(join(root, "app.dll"), dotnetBundleFixture(files).bytes);
  return root;
};

/** One dictionary whose value objects are the given encoded objects. */
const binaryPlist = (key: string, value: Buffer): Buffer => {
  const objects = [
    Buffer.from([0xd1, 1, 2]),
    Buffer.concat([Buffer.from([0x50 | key.length]), Buffer.from(key)]),
    value,
  ];
  const table =
    8 + objects.reduce((length, object) => length + object.length, 0);
  const bytes = Buffer.alloc(table + objects.length + 32);
  let cursor = 8;
  const offsets = objects.map((object) => {
    const offset = cursor;
    object.copy(bytes, cursor);
    cursor += object.length;
    return offset;
  });
  return binaryPlistObjectTable(bytes, offsets, table);
};
/** Length-prefixed object body; every test value here exceeds the short form. */
const plistObject = (type: number, length: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([(type << 4) | 0x0f, 0x10, length]), body]);

describe("ReleaseExposureReader text encodings", () => {
  const marker = "-----BEGIN PRIVATE KEY-----\n";
  const inlineMap = `//# sourceMappingURL=data:application/json;base64,${Buffer.from(
    JSON.stringify({
      version: 3,
      sources: ["src/app.ts"],
      sourcesContent: ["export {};"],
      mappings: "",
    }),
  ).toString("base64")}`;

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

  it("scans UTF-8 that holds a NUL, with its inline maps", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-text-");
    const script = `const sep = "\0";\nconst key = \`${marker}\`;\n${inlineMap}\n`;
    await writeFile(join(root, "app.js"), script);
    const scanned = await inspect(root);
    expect(scanned.text_members).toEqual({ scanned: 1, skipped: 0 });
    expect(scanned.source_maps).toMatchObject({ embedded: 1, skipped: 0 });
    expect((await visited(root)).texts).toEqual([script]);
  });

  it("does not read NUL-bearing bytes that are not UTF-8 as complete text", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-text-");
    await writeFile(
      join(root, "app.js"),
      Buffer.concat([
        Buffer.from(`const sep = "\0";\n`),
        Buffer.from([0xff]),
        Buffer.alloc(64, 0x20),
      ]),
    );
    const { texts, members } = await visited(root);
    expect(texts).toEqual([]);
    expect(members).toEqual({ scanned: 0, skipped: 1 });
  });

  it.each([
    ["ASCII", plistObject(5, marker.length, Buffer.from(marker))],
    [
      "UTF-16BE",
      plistObject(
        6,
        `clé: ${marker}`.length,
        utf16(`clé: ${marker}`, "be").subarray(2),
      ),
    ],
    ["data", plistObject(4, marker.length, Buffer.from(marker))],
  ])("scans a binary plist's %s value", async (_encoding, value) => {
    const root = await createTestTempDirectory("rea-release-exposure-text-");
    await writeFile(join(root, "Info.plist"), binaryPlist("key", value));
    const { texts, members } = await visited(root);
    expect(texts.join("")).toContain(marker);
    expect(members).toEqual({ scanned: 1, skipped: 0 });
  });

  it("scans a binary plist a package member's name does not announce as text", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-text-");
    const wide = plistObject(6, marker.length, utf16(marker, "be").subarray(2));
    await writeFile(
      join(root, "app.exe"),
      cArchiveExecutable({
        carrier: "pe",
        layout: "2.1",
        pythonVersion: 310,
        members: [
          {
            name: "Localizable.strings",
            typeCode: "x",
            compress: true,
            payload: binaryPlist("key", wide),
          },
        ],
      }),
    );
    const { texts, members } = await visited(root);
    expect(texts.join("")).toContain(marker);
    expect(members).toEqual({ scanned: 1, skipped: 0 });
  });

  it("keeps an undecodable binary plist's bytes in the scan, unassessed", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-text-");
    const bytes = Buffer.concat([
      Buffer.from("bplist00"),
      Buffer.from([0]),
      Buffer.from(marker),
    ]);
    await writeFile(join(root, "Info.plist"), bytes);
    const { texts, members } = await visited(root);
    expect(texts.join("")).toContain(marker);
    expect(members).toEqual({ scanned: 0, skipped: 1 });
  });

  it("reads an inline map from a UTF-16 script", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-text-");
    await writeFile(
      join(root, "app.js"),
      utf16(`console.log(1);\n${inlineMap}\n`, "le"),
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

describe("ReleaseExposureReader nested ASAR admission", () => {
  it("keeps a nested ASAR past the header admission unknown", async () => {
    const root = await createTestTempDirectory(
      "rea-release-nested-asar-limit-",
    );
    const map = embeddedSourceMap();
    const json = JSON.stringify({
      files: { "app.js.map": { size: map.length, offset: "0" } },
    });
    const inner = Buffer.concat([
      asarHeaderBytes(`${" ".repeat(1100)}${json}`),
      map,
    ]);
    await writeFile(
      join(root, "app.dll"),
      dotnetBundleFixture([{ path: "payload.json", bytes: inner }]).bytes,
    );
    const scanned = await inspect(join(root, "app.dll"), {
      maximumBytes: 1024,
      source: "runtime",
    });
    expect(scanned.coverage).toBe("unknown");
    expect(sourceMapSourcesStatus(scanned)).toBe("unknown");
    expect(scanned.limitations).toContain(
      "Could not decide whether payload.json holds an ASAR within the header admission.",
    );
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

  it.each(["payload.json", "payload.map", "payload.js.map"])(
    "keeps a nested ASAR an ASAR lists as %s unknown",
    async (name) => {
      const root = await createTestTempDirectory("rea-release-nested-asar-");
      const inner = asarArchive([
        { name: "app.js.map", bytes: embeddedSourceMap() },
      ]);
      await writeFile(
        join(root, "app.asar"),
        asarArchive([{ name, bytes: inner }]),
      );
      const scanned = await inspect(join(root, "app.asar"));
      expect(scanned.source_maps).toMatchObject({ embedded: 0, unparsed: 0 });
      expect(scanned.coverage).toBe("unknown");
      expect(sourceMapSourcesStatus(scanned)).toBe("unknown");
      expect(scanned.limitations).toContain(
        `Nested package ${name} was not expanded.`,
      );
    },
  );

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
      const inventory = await actual.inventoryArtifactInScope(...args);
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
    expect(scanned.omitted).toContainEqual(
      expect.objectContaining({ subject: PACKAGED_NATIVE_IMAGES, count: 1 }),
    );
    expect(scanned.coverage).toBe("unknown");
  });
});

describe("ReleaseExposureReader native members named as maps", () => {
  it("keeps a selected or listed native image named release.map out of map routing", async () => {
    const root = await createTestTempDirectory("rea-release-map-selected-");
    const elf = Buffer.alloc(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46], 0);
    elf.write("not a map\n", 16);
    const file = join(root, "release.map");
    await writeFile(file, elf);
    for (const scanned of [await inspect(file), await inspect(root)]) {
      expect(scanned.native_images).toMatchObject([
        { path: file, format: "elf" },
      ]);
      expect(scanned.debug_companions.paths).toEqual([]);
      expect(scanned.source_maps).toMatchObject({
        embedded: 0,
        skipped: 0,
        unparsed: 0,
      });
      expect(debugCompanionsStatus(scanned)).toBe("not_observed");
    }
  });

  it("keeps a selected package executable named release.map out of map routing", async () => {
    const root = await createTestTempDirectory("rea-release-map-package-");
    const file = join(root, "release.map");
    await writeFile(
      file,
      cArchiveExecutable({
        carrier: "elf",
        layout: "2.1",
        pythonVersion: 310,
        members: [
          {
            name: "notes",
            typeCode: "x",
            compress: false,
            payload: Buffer.from("plain\n"),
          },
        ],
      }),
    );
    const scanned = await inspect(file);
    expect(scanned.native_images).toMatchObject([
      { path: file, format: "elf" },
    ]);
    expect(scanned.debug_companions.paths).toEqual([]);
    expect(debugCompanionsStatus(scanned)).toBe("not_observed");
  });

  it.each([
    ["a JavaScript map name", "payload.js.map"],
    ["a linker map name", "payload.map"],
  ])("reads a native member with %s by its bytes", async (_, name) => {
    const root = await createTestTempDirectory("rea-release-map-native-");
    const file = join(root, "app");
    await writeFile(
      file,
      cArchiveExecutable({
        carrier: "elf",
        layout: "2.1",
        pythonVersion: 310,
        members: [
          {
            name,
            typeCode: "x",
            compress: true,
            payload: pe(0x8664, 64, 0x0002, false, {
              pdbPath: "C:\\build\\payload.pdb",
            }),
          },
        ],
      }),
    );
    const scanned = await inspect(root);
    expect(scanned.pdb).toMatchObject({
      examined: 1,
      failed: 0,
      paths: ["C:\\build\\payload.pdb"],
    });
    expect(scanned.pdb.image_paths).toEqual([`${file}/${name}`]);
    expect(scanned.omitted).toContainEqual(
      expect.objectContaining({ subject: PACKAGED_NATIVE_IMAGES, count: 1 }),
    );
    expect(scanned.source_maps.unparsed).toBe(0);
    expect(scanned.debug_companions.paths).toEqual([]);
  });

  it.each([
    [
      "a script's declared map",
      "loader.js",
      "//# sourceMappingURL=payload.dat\n",
    ],
    ["a page's script", "index.html", '<script src="payload.dat"></script>'],
  ])(
    "reads a native member named as %s by its bytes",
    async (_, name, text) => {
      const root = await bundled([
        { path: name, bytes: Buffer.from(text) },
        {
          path: "payload.dat",
          bytes: pe(0x8664, 64, 0x0002, false, {
            pdbPath: "C:\\build\\target.pdb",
          }),
        },
      ]);
      const scanned = await inspect(root);
      expect(scanned.pdb.paths).toContain("C:\\build\\target.pdb");
      expect(scanned.source_maps.skipped).toBe(0);
    },
  );

  it("reads short text that begins like a DOS header as text", async () => {
    const root = await bundled([
      { path: "note.txt", bytes: Buffer.from(`MZ${"a".repeat(80)}`) },
    ]);
    const scanned = await inspect(root);
    expect(scanned.textLocations).toEqual([
      `${join(root, "app.dll")}/note.txt`,
    ]);
    expect(scanned.pdb).toMatchObject({ failed: 0, paths: [] });
  });
});

describe("ReleaseExposureReader unexpanded package PE reads", () => {
  it("reads a native member by its bytes when its name says text", async () => {
    const root = await bundled([
      {
        path: "payload.json",
        bytes: pe(0x8664, 64, 0x0002, false, {
          pdbPath: "C:\\build\\payload.pdb",
        }),
      },
      { path: "plain.json", bytes: Buffer.from('{"plain":true}') },
    ]);
    const scanned = await inspect(root);
    expect(scanned.pdb.paths).toContain("C:\\build\\payload.pdb");
    expect(scanned.pdb.image_paths).toEqual([
      `${join(root, "app.dll")}/payload.json`,
    ]);
    expect(scanned.textLocations).toEqual([
      `${join(root, "app.dll")}/plain.json`,
    ]);
  });

  it.each(["payload.json", "payload.js.map"])(
    "keeps a nested ASAR named %s unknown",
    async (name) => {
      const inner = asarArchive([
        { name: "app.js.map", bytes: embeddedSourceMap() },
      ]);
      const root = await bundled([{ path: name, bytes: inner }]);
      const scanned = await inspect(root);
      expect(scanned.source_maps.embedded).toBe(0);
      expect(scanned.coverage).toBe("unknown");
      expect(sourceMapSourcesStatus(scanned)).toBe("unknown");
      expect(scanned.limitations).toContain(
        `Nested package ${join(root, "app.dll")}/${name} was not expanded.`,
      );
    },
  );

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

  it("leaves member coverage unknown when a packaged native image cannot be read", async () => {
    const root = await createTestTempDirectory("rea-release-unread-native-");
    const elf = Buffer.alloc(64);
    elf.set([0x7f, 0x45, 0x4c, 0x46], 0);
    await writeFile(
      join(root, "app.asar"),
      asarArchive([{ name: "native.node", bytes: elf }]),
    );
    createdReaders.wrap = (reader, path) => {
      if (path !== join(root, "app.asar")) return reader;
      const open = reader.open.bind(reader);
      reader.open = (entry, signal) =>
        entry.path.endsWith("native.node")
          ? Promise.reject(new Error("member read failed"))
          : open(entry, signal);
      return reader;
    };
    try {
      const scanned = await inspect(root);
      expect(scanned.coverage).toBe("unknown");
      expect(scanned.limitations).toContain(
        "Did not probe app.asar/native.node for an embedded package.",
      );
      expect(scanned.extractable.unreadable_members).toBe(1);
    } finally {
      createdReaders.wrap = undefined;
    }
  });

  it("leaves member coverage unknown when an unclassified packaged member cannot be read", async () => {
    const root = await bundled([
      { path: "payload.bin", bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) },
    ]);
    createdReaders.wrap = (reader, path) => {
      if (!path.endsWith("app.dll")) return reader;
      const open = reader.open.bind(reader);
      reader.open = (entry, signal) =>
        entry.path.endsWith("payload.bin")
          ? Promise.reject(new Error("member read failed"))
          : open(entry, signal);
      return reader;
    };
    try {
      const scanned = await inspect(root);
      expect(scanned.coverage).toBe("unknown");
      expect(scanned.limitations).toContain(
        `Could not read ${join(root, "app.dll", "payload.bin")} to rule out a native image or package.`,
      );
    } finally {
      createdReaders.wrap = undefined;
    }
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

describe("ReleaseExposureReader probed FAT identity", () => {
  const omittedNative = async (bytes: Buffer): Promise<number | undefined> => {
    const root = await bundled([{ path: "member.bin", bytes }]);
    const scanned = await inspect(root);
    return scanned.omitted.find(
      (item) => item.subject === PACKAGED_NATIVE_IMAGES,
    )?.count;
  };

  it("keeps a JVM class past the probe out of the packaged native images", async () => {
    const bytes = javaClassFile(MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES);
    expect(bytes.length).toBeGreaterThan(
      MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES,
    );
    await expect(omittedNative(bytes)).resolves.toBeUndefined();
  });

  it("counts a universal image whose slice headers sit past the probe", async () => {
    const slice = Buffer.alloc(64);
    slice.writeUInt32BE(0xcffaedfe, 0);
    const { bytes, slices } = universalMacho([
      { bytes: slice, cpuType: 0x0100000c, cpuSubtype: 0 },
    ]);
    expect(slices[0]?.offset).toBeGreaterThanOrEqual(
      MAX_RELEASE_EXPOSURE_MEMBER_PROBE_BYTES,
    );
    await expect(omittedNative(bytes)).resolves.toBe(1);
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
    "reports and retains a descriptor whose close failed after $name",
    async ({ selected, write }) => {
      const root = await createTestTempDirectory("rea-release-exposure-fd-");
      await write(root);
      const actual = await vi.importActual<
        typeof import("./inventory/ArtifactInventory.js")
      >("./inventory/ArtifactInventory.js");
      inventoryRead.impl = async (...args) => {
        const inventory = await actual.inventoryArtifactInScope(...args);
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
        if (result.ok) throw new Error("expected cleanup-incomplete failure");
        expect(result.error.cleanupIncomplete).toBe(true);
        expect(result.error.cleanupResources.join("\n")).toContain(selected);
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

describe("ReleaseExposureReader cleanup-bearing read failures", () => {
  const cleanupFailure = (
    reason: "limit" | "format",
    resource: string,
  ): ArtifactReaderFailure =>
    ArtifactReaderFailure.withCleanup(
      new ArtifactReaderFailure(reason, `${reason} failure: ${resource}`),
      { reason: "close failed", resources: [resource] },
    );

  it("does not read a cleanup-incomplete limit failure as an oversized member", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-limit-");
    await writeFile(join(root, "bundle.map"), "{}");
    const real = stableRead.impl;
    stableRead.impl = async (...args) => {
      if (args[0].endsWith("bundle.map"))
        throw cleanupFailure("limit", args[0]);
      return (real as NonNullable<typeof real>)(...args);
    };
    const reader = new ReleaseExposureReader();
    try {
      const result = await reader.inspect(
        { path: root },
        undefined,
        ignoreText,
      );
      if (result.ok) throw new Error("expected cleanup-incomplete failure");
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.cleanupResources.join("\n")).toContain("bundle.map");
    } finally {
      stableRead.impl = real;
      await reader.close();
    }
  });

  it("reports what it found before a member's cleanup failed", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-stop-");
    await writeFile(
      join(root, "a.js.map"),
      JSON.stringify({ version: 3, sources: ["a.ts"], mappings: "" }),
    );
    await writeFile(join(root, "z.map"), "{}");
    const real = stableRead.impl;
    stableRead.impl = async (...args) => {
      if (args[0].endsWith("z.map")) throw cleanupFailure("limit", args[0]);
      return (real as NonNullable<typeof real>)(...args);
    };
    const reader = new ReleaseExposureReader();
    const interrupted: ReleaseExposureScan[] = [];
    try {
      const result = await reader.inspect(
        { path: root },
        undefined,
        ignoreText,
        (scan) => interrupted.push(scan),
      );
      if (result.ok) throw new Error("expected cleanup-incomplete failure");
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(interrupted).toHaveLength(1);
      expect(interrupted[0]?.coverage).toBe("unknown");
      expect(interrupted[0]?.source_maps.without_sources).toBe(1);
      expect(interrupted[0]?.limitations[0]).toContain("unfinished cleanup");
    } finally {
      stableRead.impl = real;
      await reader.close();
    }
  });

  it("does not read cleanup-incomplete inventory as unknown coverage", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-inv-");
    const selected = join(root, "app");
    await writeFile(selected, "selected");
    inventoryRead.impl = () =>
      Promise.reject(cleanupFailure("format", selected));
    const reader = new ReleaseExposureReader();
    try {
      const result = await reader.inspect(
        { path: selected },
        undefined,
        ignoreText,
      );
      if (result.ok) throw new Error("expected cleanup-incomplete failure");
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.cleanupResources).toContain(selected);
    } finally {
      inventoryRead.impl = undefined;
      await reader.close();
    }
  });
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

  it.each([
    ["app.js", { embedded: 0, unparsed: 1, skipped: 0 }],
    ["z.js", { embedded: 0, unparsed: 0, skipped: 1 }],
  ])(
    "keeps a malformed assets.map that %s declares unresolved",
    async (script, expected) => {
      const root = await createTestTempDirectory("rea-release-generic-map-");
      await writeFile(
        join(root, script),
        "const value = 1;\n//# sourceMappingURL=assets.map\n",
      );
      await writeFile(join(root, "assets.map"), "not a map\n");
      const scanned = await inspect(root);
      expect(scanned.source_maps).toMatchObject(expected);
      expect(scanned.debug_companions.paths).toEqual([]);
    },
  );

  it("keeps an undeclared malformed assets.map a linker map", async () => {
    const root = await createTestTempDirectory("rea-release-linker-map-");
    await writeFile(join(root, "assets.map"), "not a map\n");
    const scanned = await inspect(root);
    expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 0 });
    expect(scanned.debug_companions.paths).toHaveLength(1);
  });

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

const malformedLeaf = (mappings: string) => ({
  version: 3,
  sources: ["b.js"],
  names: [],
  mappings,
});

const debugCompanionsStatus = (scan: ReleaseExposureScan) =>
  assembleReleaseExposureReport(scan, {
    electron_family: "not_electron",
    fuse_images: [],
    go_images: [],
    rust_images: [],
    credential_markers: { hits: [], omitted_hits: 0 },
  }).checks.find((check) => check.id === "native.debug_companions")?.status;

const sourceMapSourcesStatus = (scan: ReleaseExposureScan) =>
  assembleReleaseExposureReport(scan, {
    electron_family: "not_electron",
    fuse_images: [],
    go_images: [],
    rust_images: [],
    credential_markers: { hits: [], omitted_hits: 0 },
  }).checks.find((check) => check.id === "javascript.source_map_sources")
    ?.status;

const inspect = async (path: string, admission?: AsarHeaderAdmission) => {
  const reader = new ReleaseExposureReader(admission);
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

describe("ReleaseExposureReader inline map reads", () => {
  const map = Buffer.from(
    JSON.stringify({
      version: 3,
      sources: ["src/app.ts"],
      sourcesContent: ["export {};"],
      mappings: "",
    }),
  ).toString("base64");

  const dataUrl = `data:application/json;base64,${map}`;

  it.each([
    ["a classic script", "<script>"],
    ["a module script", '<script type="module">'],
  ])("reads an inline map in %s of an HTML file", async (_, open) => {
    const root = await createTestTempDirectory("rea-release-exposure-html-");
    await writeFile(
      join(root, "index.html"),
      `<!doctype html>${open}\nrun();\n//# sourceMappingURL=${dataUrl}\n</script>`,
    );
    const scanned = await inspect(root);
    expect(scanned.source_maps).toMatchObject({ embedded: 1, skipped: 0 });
    expect(sourceMapSourcesStatus(scanned)).toBe("exposed");
  });

  it("reads an inline map in an HTML member of an ASAR", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-html-");
    const path = join(root, "app.asar");
    await writeFile(
      path,
      asarArchive([
        {
          name: "index.html",
          bytes: Buffer.from(
            `<script>//# sourceMappingURL=${dataUrl}\n</script>`,
          ),
        },
      ]),
    );
    expect(sourceMapSourcesStatus(await inspect(path))).toBe("exposed");
  });

  it("does not read a map in a data block or a script that loads by URL", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-html-");
    await writeFile(join(root, "app.js"), "run();\n");
    await writeFile(
      join(root, "index.html"),
      `<script type="application/json">//# sourceMappingURL=${dataUrl}\n</script>` +
        `<script src="app.js">//# sourceMappingURL=${dataUrl}\n</script>`,
    );
    const scanned = await inspect(root);
    expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 0 });
    expect(sourceMapSourcesStatus(scanned)).toBe("not_observed");
  });

  it("keeps HTML map coverage unknown for scripts it did not read", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-html-");
    const path = join(root, "index.html");
    await writeFile(
      path,
      "<script>x</script>".repeat(HTML_INLINE_SCRIPT_LOCATION_LIMIT + 2),
    );
    const past = await inspect(path);
    expect(past.source_maps.skipped).toBe(2);
    expect(sourceMapSourcesStatus(past)).toBe("unknown");
    await writeFile(
      path,
      Buffer.alloc(MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES + 1, 0x20),
    );
    expect((await inspect(path)).source_maps.skipped).toBe(1);
  });

  const bunExecutable = (sourcemap: Buffer): Buffer =>
    elfBunSection(
      bunPrefixedPayload(
        bunModuleGraphPayload({
          modules: [
            {
              name: "/$bunfs/root/main.js",
              contents: Buffer.from("run();\n"),
              sourcemap,
            },
          ],
        }),
      ),
    );

  it.each([
    ["a selected executable", (root: string) => join(root, "server")],
    ["an executable in a directory", (root: string) => root],
  ])("reads a Bun sourcemap region in %s", async (_, selected) => {
    const root = await createTestTempDirectory("rea-release-exposure-bun-");
    await writeFile(
      join(root, "server"),
      bunExecutable(Buffer.from(map, "base64")),
    );
    const scanned = await inspect(selected(root));
    expect(scanned.source_maps).toMatchObject({ embedded: 1, unparsed: 0 });
    expect(sourceMapSourcesStatus(scanned)).toBe("exposed");
  });

  it("keeps a binary Bun sourcemap region unresolved instead of a companion", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-bun-");
    await writeFile(
      join(root, "server"),
      bunExecutable(Buffer.from([1, 0, 0, 0, 0xff, 0xfe, 0, 0])),
    );
    const scanned = await inspect(join(root, "server"));
    expect(scanned.source_maps.unparsed).toBe(1);
    expect(scanned.debug_companions.paths).toEqual([]);
    expect(sourceMapSourcesStatus(scanned)).toBe("unknown");
  });

  it("reads a percent-escaped base64 inline map", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-map-");
    const escaped = `%${map.charCodeAt(0).toString(16)}${map.slice(1)}`;
    await writeFile(
      join(root, "app.js"),
      `//# sourceMappingURL=data:application/json;base64,${escaped}\n`,
    );
    const { source_maps: maps } = await inspect(root);
    expect(maps.embedded).toBe(1);
    expect(maps.unparsed).toBe(0);
  });

  it("reads the inline map of an extensionless SEA entry in a directory", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-map-");
    await writeFile(
      join(root, "app"),
      nodeSeaElf({
        codePath: "entry",
        main: `//# sourceMappingURL=data:application/json;base64,${map}\n`,
      }),
    );
    expect((await inspect(root)).source_maps.embedded).toBe(1);
  });

  it("reads a SEA entry named .map as JavaScript, not as a linker map", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-map-");
    await writeFile(
      join(root, "app"),
      nodeSeaElf({
        codePath: "boot.map",
        main: `//# sourceMappingURL=data:application/json;base64,${map}\n`,
      }),
    );
    const scanned = await inspect(root);
    expect(scanned.source_maps.embedded).toBe(1);
    expect(scanned.debug_companions).toEqual({ paths: [], skipped: 0 });
  });
});

describe("ReleaseExposureReader Node shebang scripts", () => {
  const dataUrl = `data:application/json;base64,${Buffer.from(
    JSON.stringify({
      version: 3,
      sources: ["src/app.ts"],
      sourcesContent: ["export {};"],
      mappings: "",
    }),
  ).toString("base64")}`;

  const script = (shebang: string): string =>
    `${shebang}\nrun();\n//# sourceMappingURL=${dataUrl}\n`;

  const shebangRoot = async (): Promise<string> =>
    createTestTempDirectory("rea-release-exposure-shebang-");

  it.each([
    ["#!/usr/bin/env node"],
    ["#!/usr/bin/env node\r"],
    ["#!/usr/bin/env -S node --no-warnings"],
    ["#!/usr/bin/env -S -u NODE_OPTIONS node"],
    ["#!/usr/bin/env -u NODE_OPTIONS node"],
    ["#!/usr/bin/env -C /srv/app node"],
    ["#!/usr/bin/env -Snode --no-warnings"],
    ["#!/usr/bin/env --unset NODE_OPTIONS -- node"],
    ["#!/usr/bin/env -S -- MODE=production node"],
    ["#!/usr/local/bin/node --no-warnings"],
    ["#! /usr/bin/nodejs"],
  ])("reads the map of %j in a directory", async (shebang) => {
    const root = await shebangRoot();
    await writeFile(join(root, "runner"), script(shebang));
    const scanned = await inspect(root);
    expect(scanned.source_maps).toMatchObject({ embedded: 1, skipped: 0 });
    expect(sourceMapSourcesStatus(scanned)).toBe("exposed");
  });

  it("reads the map of a selected file", async () => {
    const path = join(await shebangRoot(), "runner");
    await writeFile(path, script("#!/usr/bin/env node"));
    expect(sourceMapSourcesStatus(await inspect(path))).toBe("exposed");
  });

  it.each(["app.js.map", "debug.map"])(
    "keeps a sibling %s a selected file declares unknown",
    async (map) => {
      const root = await shebangRoot();
      const path = join(root, "runner");
      await writeFile(
        path,
        `#!/usr/bin/env node\nrun();\n//# sourceMappingURL=${map}\n`,
      );
      await writeFile(join(root, map), embeddedSourceMap());
      const scanned = await inspect(path);
      expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 1 });
      expect(sourceMapSourcesStatus(scanned)).toBe("unknown");
    },
  );

  it("reads the map of an ASAR member", async () => {
    const path = join(await shebangRoot(), "app.asar");
    await writeFile(
      path,
      asarArchive([
        {
          name: "runner",
          bytes: Buffer.from(script("#!/usr/bin/env node")),
        },
      ]),
    );
    expect(sourceMapSourcesStatus(await inspect(path))).toBe("exposed");
  });

  it("keeps coverage unknown for a script past the text allowance", async () => {
    const root = await shebangRoot();
    await writeFile(
      join(root, "runner"),
      `${script("#!/usr/bin/env node")}${" ".repeat(
        MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES,
      )}`,
    );
    const scanned = await inspect(root);
    expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 1 });
    expect(sourceMapSourcesStatus(scanned)).toBe("unknown");
  });

  it("keeps coverage unknown for a script that does not decode", async () => {
    const root = await shebangRoot();
    await writeFile(
      join(root, "runner"),
      Buffer.concat([
        Buffer.from("#!/usr/bin/env node\n"),
        Buffer.from(script("").repeat(2), "utf16le"),
      ]),
    );
    const scanned = await inspect(root);
    expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 1 });
    expect(sourceMapSourcesStatus(scanned)).toBe("unknown");
  });

  it("does not count a shebang script an HTML file loads later as unread", async () => {
    const root = await shebangRoot();
    await writeFile(join(root, "app"), script("#!/usr/bin/env node"));
    await writeFile(join(root, "index.html"), '<script src="app"></script>');
    const scanned = await inspect(root);
    expect(scanned.source_maps).toMatchObject({ embedded: 1, skipped: 0 });
    expect(sourceMapSourcesStatus(scanned)).toBe("exposed");
  });

  it.each([
    ["#!/bin/sh"],
    ["#!/usr/bin/env python3"],
    ["#!/usr/bin/env nodemon"],
    ["#!/opt/node/bin/python3 node"],
  ])("does not read %j as JavaScript", async (shebang) => {
    const root = await shebangRoot();
    await writeFile(join(root, "runner"), script(shebang));
    const scanned = await inspect(root);
    expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 0 });
  });
});

describe("ReleaseExposureReader resource admission", () => {
  it("holds one scope admission for a whole audit", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-scope-");
    await writeFile(join(root, "app.js"), "run();\n");
    const run = ArtifactResourceScope.prototype.run;
    let depth = 0;
    let deepest = 0;
    const admitted = vi
      .spyOn(ArtifactResourceScope.prototype, "run")
      .mockImplementation(async function (
        this: ArtifactResourceScope,
        operation,
      ) {
        depth += 1;
        deepest = Math.max(deepest, depth);
        try {
          return await run.call(this, operation);
        } finally {
          depth -= 1;
        }
      } as typeof run);
    try {
      await inspect(root);
      await inspect(join(root, "app.js"));
    } finally {
      admitted.mockRestore();
    }
    expect(deepest).toBe(1);
  });
});

describe("ReleaseExposureReader map target allowance", () => {
  it("keeps a map past the target allowance unassessed", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-maps-");
    const folder = join(
      root,
      ...Array.from({ length: 4 }, () => "d".repeat(200)),
    );
    await mkdir(folder, { recursive: true });
    const declarations = Array.from(
      { length: Math.ceil(MAX_RELEASE_EXPOSURE_MAP_TARGET_BYTES / 800) + 1 },
      (_, index) => `//# sourceMappingURL=m${String(index)}`,
    );
    await writeFile(
      join(folder, "a.js"),
      `${declarations.join("\n")}\n//# sourceMappingURL=z\n`,
    );
    await writeFile(
      join(folder, "z"),
      JSON.stringify({
        version: 3,
        sources: ["s.ts"],
        sourcesContent: ["x"],
        mappings: "",
      }),
    );
    const scanned = await inspect(root);
    expect(scanned.source_maps.embedded).toBe(0);
    expect(sourceMapSourcesStatus(scanned)).toBe("unknown");
  });

  it("does not read a .map past the target allowance as a linker map", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-maps-");
    const folder = join(
      root,
      ...Array.from({ length: 4 }, () => "d".repeat(200)),
    );
    await mkdir(folder, { recursive: true });
    const declarations = Array.from(
      { length: Math.ceil(MAX_RELEASE_EXPOSURE_MAP_TARGET_BYTES / 800) + 1 },
      (_, index) => `//# sourceMappingURL=m${String(index)}`,
    );
    await writeFile(
      join(folder, "a.js"),
      `${declarations.join("\n")}\n//# sourceMappingURL=z.map\n`,
    );
    await writeFile(join(folder, "z.map"), "not a map\n");
    const scanned = await inspect(root);
    expect(scanned.debug_companions.paths).toEqual([]);
    expect(scanned.debug_companions.skipped).toBeGreaterThan(0);
    expect(debugCompanionsStatus(scanned)).toBe("unknown");
    expect(scanned.source_maps.skipped).toBeGreaterThan(0);
  });

  it("does not read a .map script past the target allowance as a linker map", async () => {
    const baseBytes = 64 * 1024;
    const references = Array.from(
      { length: MAX_RELEASE_EXPOSURE_SCRIPT_TARGET_BYTES / baseBytes + 1 },
      (_, index) => `<script src="s${String(index)}"></script>`,
    );
    const root = await createTestTempDirectory("rea-release-exposure-maps-");
    await writeFile(
      join(root, "a.html"),
      `<base href="/${"a".repeat(baseBytes)}/">${references.join("")}`,
    );
    await writeFile(join(root, "b.html"), '<script src="boot.map"></script>');
    await writeFile(join(root, "boot.map"), "run();\n");
    const scanned = await inspect(root);
    expect(scanned.debug_companions.paths).toEqual([]);
    expect(debugCompanionsStatus(scanned)).toBe("unknown");
  });
});

describe("ReleaseExposureReader script roles over a .map name", () => {
  it("reads a .map script an HTML file loads as JavaScript", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-html-");
    const map = Buffer.from(
      JSON.stringify({
        version: 3,
        sources: ["src/app.ts"],
        sourcesContent: ["export {};"],
        mappings: "",
      }),
    ).toString("base64");
    await writeFile(
      join(root, "index.html"),
      '<script src="main.map"></script>',
    );
    await writeFile(
      join(root, "main.map"),
      `//# sourceMappingURL=data:application/json;base64,${map}\n`,
    );
    const scanned = await inspect(root);
    expect(scanned.source_maps).toMatchObject({ embedded: 1, skipped: 0 });
    expect(sourceMapSourcesStatus(scanned)).toBe("exposed");
    expect(scanned.debug_companions).toEqual({ paths: [], skipped: 0 });
  });

  it("reads a .map script target whose bytes are a source map as a map", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-html-");
    await writeFile(
      join(root, "index.html"),
      '<script src="main.map"></script>',
    );
    await writeFile(
      join(root, "main.map"),
      JSON.stringify({
        version: 3,
        sources: ["src/app.ts"],
        sourcesContent: ["export {};"],
        mappings: "",
      }),
    );
    const scanned = await inspect(root);
    expect(scanned.source_maps).toMatchObject({ embedded: 1, skipped: 0 });
    expect(sourceMapSourcesStatus(scanned)).toBe("exposed");
    expect(scanned.debug_companions).toEqual({ paths: [], skipped: 0 });
  });

  it("reads a UTF-16 .map script target from the text that recognized it", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-html-");
    await writeFile(
      join(root, "index.html"),
      '<script src="main.map"></script>',
    );
    const map = JSON.stringify({
      version: 3,
      sources: ["src/app.ts"],
      sourcesContent: ["export {};"],
      mappings: "",
    });
    await writeFile(
      join(root, "main.map"),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(map, "utf16le")]),
    );
    const scanned = await inspect(root);
    expect(scanned.source_maps).toMatchObject({ embedded: 1, skipped: 0 });
    expect(sourceMapSourcesStatus(scanned)).toBe("exposed");
    expect(scanned.debug_companions).toEqual({ paths: [], skipped: 0 });
  });

  it("retracts a linker-map guess when a later page loads the .map as a script", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-html-");
    await writeFile(join(root, "app.map"), "run();\n");
    await writeFile(
      join(root, "index.html"),
      '<script src="app.map"></script>',
    );
    const archive = join(
      await createTestTempDirectory("rea-release-exposure-html-"),
      "app.asar",
    );
    await writeFile(
      archive,
      asarArchive([
        { name: "app.map", bytes: Buffer.from("run();\n") },
        {
          name: "index.html",
          bytes: Buffer.from('<script src="app.map"></script>'),
        },
      ]),
    );
    for (const target of [root, archive]) {
      const scanned = await inspect(target);
      expect(scanned.debug_companions.paths).toEqual([]);
      expect(debugCompanionsStatus(scanned)).not.toBe("exposed");
      expect(scanned.source_maps.skipped).toBeGreaterThan(0);
      expect(sourceMapSourcesStatus(scanned)).toBe("unknown");
    }
  });
});

describe("ReleaseExposureReader HTML script references", () => {
  const inlineMap = `//# sourceMappingURL=data:application/json;base64,${Buffer.from(
    JSON.stringify({
      version: 3,
      sources: ["src/app.ts"],
      sourcesContent: ["export {};"],
      mappings: "",
    }),
  ).toString("base64")}\n`;

  const directory = async (
    files: Readonly<Record<string, string>>,
  ): Promise<string> => {
    const root = await createTestTempDirectory("rea-release-exposure-html-");
    for (const [name, text] of Object.entries(files))
      await writeFile(join(root, name), text);
    return root;
  };

  it("reads the inline map of an extensionless script an HTML file loads", async () => {
    const scanned = await inspect(
      await directory({
        "index.html": '<script src="main"></script>',
        main: inlineMap,
      }),
    );
    expect(scanned.source_maps).toMatchObject({ embedded: 1, skipped: 0 });
    expect(sourceMapSourcesStatus(scanned)).toBe("exposed");
  });

  it("reads an extensionless script an ASAR's HTML loads", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-html-");
    const path = join(root, "app.asar");
    await writeFile(
      path,
      asarArchive([
        {
          name: "index.html",
          bytes: Buffer.from('<script src="main"></script>'),
        },
        { name: "main", bytes: Buffer.from(inlineMap) },
      ]),
    );
    expect(sourceMapSourcesStatus(await inspect(path))).toBe("exposed");
  });

  it("resolves a script against the document base", async () => {
    const root = await directory({
      "index.html": '<base href="static/"><script src="main?v=1"></script>',
    });
    await mkdir(join(root, "static"));
    await writeFile(join(root, "static", "main"), inlineMap);
    expect(sourceMapSourcesStatus(await inspect(root))).toBe("exposed");
  });

  it("does not count a script two pages share as unread", async () => {
    const scanned = await inspect(
      await directory({
        "a.html": '<script src="main"></script>',
        main: inlineMap,
        "z.html": '<script src="main"></script>',
      }),
    );
    expect(scanned.source_maps).toMatchObject({ embedded: 1, skipped: 0 });
  });

  it("reads the scripts of a standalone SVG", async () => {
    const scanned = await inspect(
      await directory({
        "screen.svg": `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script><![CDATA[\nrun();\n${inlineMap}]]></script></svg>`,
      }),
    );
    expect(scanned.source_maps.embedded).toBe(1);
    expect(sourceMapSourcesStatus(scanned)).toBe("exposed");
  });

  it("finds nothing in an SVG without scripts", async () => {
    const scanned = await inspect(
      await directory({
        "icon.svg":
          '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
      }),
    );
    expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 0 });
  });

  it("still reads a page another page loads as a script as HTML", async () => {
    const scanned = await inspect(
      await directory({
        "a.html": '<script src="z.html"></script>',
        "z.html": `<!doctype html><script>\nrun();\n${inlineMap}</script>`,
      }),
    );
    expect(scanned.source_maps.embedded).toBe(1);
    expect(sourceMapSourcesStatus(scanned)).toBe("exposed");
  });

  it("keeps a script past the target allowance unassessed", async () => {
    const baseBytes = 64 * 1024;
    const references = Array.from(
      { length: MAX_RELEASE_EXPOSURE_SCRIPT_TARGET_BYTES / baseBytes + 1 },
      (_, index) => `<script src="s${String(index)}"></script>`,
    );
    const scanned = await inspect(
      await directory({
        "a.html": `<base href="/${"a".repeat(baseBytes)}/">${references.join("")}`,
        "b.html": '<script src="main"></script>',
        main: inlineMap,
      }),
    );
    expect(scanned.source_maps).toMatchObject({
      embedded: 0,
      skipped: references.length + 1,
    });
    expect(sourceMapSourcesStatus(scanned)).toBe("unknown");
  });

  it("keeps coverage unknown for a script read before its HTML file", async () => {
    const scanned = await inspect(
      await directory({
        app: inlineMap,
        "index.html": '<script src="app"></script>',
      }),
    );
    expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 1 });
    expect(sourceMapSourcesStatus(scanned)).toBe("unknown");
  });

  it("keeps coverage unknown for a named script beside a selected HTML file", async () => {
    const page = '<script src="app.js"></script>';
    const root = await directory({ "app.js": inlineMap, "index.html": page });
    const scanned = await inspect(join(root, "index.html"));
    expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 1 });
    expect(sourceMapSourcesStatus(scanned)).toBe("unknown");
  });

  it.each([
    ["a missing member", "main"],
    ["a path from a root the audit cannot place", "/main"],
    ["a scheme the audit cannot resolve", "app://./main"],
  ])("keeps coverage unknown for %s", async (_, src) => {
    const scanned = await inspect(
      await directory({ "index.html": `<script src="${src}"></script>` }),
    );
    expect(scanned.source_maps.skipped).toBe(1);
    expect(sourceMapSourcesStatus(scanned)).toBe("unknown");
  });

  it("leaves coverage alone for remote, named, and data-block references", async () => {
    const scanned = await inspect(
      await directory({
        "app.js": "run();\n",
        "index.html":
          '<script src="https://cdn.example/lib"></script>' +
          '<script src="app.js?v=1"></script>' +
          '<script type="text/plain" src="notes"></script>',
      }),
    );
    expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 0 });
    expect(sourceMapSourcesStatus(scanned)).toBe("not_observed");
  });
});

describe("ReleaseExposureReader cumulative text allowance", () => {
  const MEMBERS_PAST_ALLOWANCE = 20;
  const MEMBERS_IN_ALLOWANCE =
    MAX_RELEASE_EXPOSURE_TEXT_BYTES / MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES;

  /** Compressed text members, then one small member the allowance decides. */
  const packageRoot = async (bytes: Buffer): Promise<string> => {
    const root = await createTestTempDirectory("rea-release-exposure-text-");
    await writeFile(
      join(root, "app.dll"),
      dotnetBundleFixture([
        ...Array.from({ length: MEMBERS_PAST_ALLOWANCE }, (_, index) => ({
          path: `m${String(index)}.txt`,
          bytes,
          compressed: true,
        })),
        { path: "last.txt", bytes: Buffer.from("hello\n") },
      ]).bytes,
    );
    return root;
  };

  const inspectCountingOpens = async (
    root: string,
    open?: (entry: ArtifactEntry) => Readable | undefined,
  ) => {
    let opened = 0;
    createdReaders.wrap = (reader, path) => {
      if (path !== join(root, "app.dll")) return reader;
      const openEntry = reader.open.bind(reader);
      reader.open = (entry, signal) => {
        if (entry.path.startsWith("m")) opened += 1;
        const replaced = open?.(entry);
        return replaced === undefined
          ? openEntry(entry, signal)
          : Promise.resolve(replaced);
      };
      return reader;
    };
    try {
      return { scanned: await inspect(root), opened: () => opened };
    } finally {
      createdReaders.wrap = undefined;
    }
  };

  it("charges oversized package text reads to the allowance", async () => {
    const { scanned, opened } = await inspectCountingOpens(
      await packageRoot(
        Buffer.alloc(MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES + 1, 0x20),
      ),
    );
    expect(opened()).toBeLessThanOrEqual(MEMBERS_IN_ALLOWANCE);
    expect(scanned.textLocations).toEqual([]);
    expect(scanned.text_members).toEqual({
      scanned: 0,
      skipped: MEMBERS_PAST_ALLOWANCE + 1,
    });
  });

  it("charges package text that did not decode to the allowance", async () => {
    const utf32 = Buffer.alloc(MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES);
    Buffer.from([0xff, 0xfe, 0, 0]).copy(utf32);
    const { scanned, opened } = await inspectCountingOpens(
      await packageRoot(utf32),
    );
    expect(opened()).toBe(MEMBERS_IN_ALLOWANCE);
    expect(scanned.textLocations).toEqual([]);
  });

  it("charges the bytes of a package read that failed partway", async () => {
    const { scanned, opened } = await inspectCountingOpens(
      await packageRoot(Buffer.from("unread\n")),
      (entry) =>
        entry.path.startsWith("m")
          ? Readable.from(
              (function* (): Generator<Buffer> {
                yield Buffer.alloc(MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES);
                throw new Error("damaged member");
              })(),
            )
          : undefined,
    );
    expect(opened()).toBe(MEMBERS_IN_ALLOWANCE);
    expect(scanned.textLocations).toEqual([]);
  });

  it("keeps an unclassified package member past the allowance unknown", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-text-");
    const inner = asarArchive([
      { name: "app.js.map", bytes: embeddedSourceMap() },
    ]);
    await writeFile(
      join(root, "app.dll"),
      dotnetBundleFixture([
        ...Array.from({ length: MEMBERS_PAST_ALLOWANCE }, (_, index) => ({
          path: `m${String(index)}.txt`,
          bytes: Buffer.alloc(MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES, 0x20),
          compressed: true,
        })),
        { path: "payload.json", bytes: inner },
      ]).bytes,
    );
    const scanned = await inspect(root);
    expect(scanned.coverage).toBe("unknown");
    expect(sourceMapSourcesStatus(scanned)).toBe("unknown");
    expect(scanned.limitations).toContain(
      `Did not read ${join(root, "app.dll")}/payload.json past the text allowance to rule out a native image or package.`,
    );
  });

  it("charges only the probe for an oversized file on disk", async () => {
    const root = await createTestTempDirectory("rea-release-exposure-disk-");
    for (let index = 0; index < MEMBERS_PAST_ALLOWANCE; index += 1)
      await writeFile(
        join(root, `m${String(index)}.txt`),
        Buffer.alloc(MAX_RELEASE_EXPOSURE_TEXT_MEMBER_BYTES + 1, 0x20),
      );
    await writeFile(join(root, "z.txt"), "hello\n");
    const scanned = await inspect(root);
    expect(scanned.textLocations).toEqual([join(root, "z.txt")]);
    expect(scanned.text_members).toEqual({
      scanned: 1,
      skipped: MEMBERS_PAST_ALLOWANCE,
    });
  });
});

describe("ReleaseExposureReader unfollowed map links", () => {
  const SCRIPT = "const value = 1;\n//# sourceMappingURL=app.js.map\n";
  const EMBEDDED_PAYLOAD = `const value = 1;\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(
    JSON.stringify({
      version: 3,
      sources: ["a.ts"],
      sourcesContent: ["const value = 1;"],
      mappings: "",
    }),
  ).toString("base64")}\n`;

  it.skipIf(process.platform === "win32")(
    "counts a map symlink in a directory as skipped once, declared or not",
    async () => {
      for (const script of ["const value = 1;\n", SCRIPT]) {
        const root = await createTestTempDirectory("rea-release-map-link-");
        await writeFile(join(root, "payload"), "not read\n");
        await writeFile(join(root, "app.js"), script);
        await symlink("payload", join(root, "app.js.map"));
        const scanned = await inspect(root);
        expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 1 });
        expect(scanned.omitted).toContainEqual(
          expect.objectContaining({ subject: "source maps", count: 1 }),
        );
      }
    },
  );

  it("counts a map link in an ASAR as skipped", async () => {
    const root = await createTestTempDirectory("rea-release-asar-map-link-");
    const archive = join(root, "app.asar");
    const payload = Buffer.from("not read\n");
    await writeFile(
      archive,
      Buffer.concat([
        asarHeaderBytes(
          JSON.stringify({
            files: {
              "app.js.map": { link: "payload" },
              payload: { size: payload.length, offset: "0" },
            },
          }),
        ),
        payload,
      ]),
    );
    const scanned = await inspect(archive);
    expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 1 });
    expect(scanned.omitted).toContainEqual(
      expect.objectContaining({ subject: "source maps", count: 1 }),
    );
  });

  it.skipIf(process.platform === "win32")(
    "counts a directory link whose name can hold a map directive as skipped",
    async () => {
      for (const name of ["app.js", "index.html", "screen.svg", "app.css"]) {
        const root = await createTestTempDirectory("rea-release-script-link-");
        await writeFile(join(root, "payload"), EMBEDDED_PAYLOAD);
        await symlink("payload", join(root, name));
        const scanned = await inspect(root);
        expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 1 });
        expect(scanned.omitted).toContainEqual(
          expect.objectContaining({ subject: "source maps", count: 1 }),
        );
      }
    },
  );

  it("counts a script link in an ASAR as skipped", async () => {
    const root = await createTestTempDirectory("rea-release-asar-script-link-");
    const archive = join(root, "app.asar");
    const payload = Buffer.from(EMBEDDED_PAYLOAD);
    await writeFile(
      archive,
      Buffer.concat([
        asarHeaderBytes(
          JSON.stringify({
            files: {
              "app.js": { link: "payload" },
              payload: { size: payload.length, offset: "0" },
            },
          }),
        ),
        payload,
      ]),
    );
    expect((await inspect(archive)).source_maps).toMatchObject({
      embedded: 0,
      skipped: 1,
    });
  });

  it.skipIf(process.platform === "win32")(
    "counts a script link once when a page or script also names it",
    async () => {
      for (const [name, page] of [
        ["a-link.svg", '<script src="a-link.svg"></script>'],
        ["z-link.svg", '<script src="z-link.svg"></script>'],
      ] as const) {
        const root = await createTestTempDirectory("rea-release-loaded-link-");
        await writeFile(join(root, "payload"), "not read\n");
        await writeFile(join(root, "m-index.html"), page);
        await symlink("payload", join(root, name));
        expect((await inspect(root)).source_maps.skipped).toBe(1);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "leaves a link that names no map out of the map counts",
    async () => {
      const root = await createTestTempDirectory("rea-release-other-link-");
      await writeFile(join(root, "payload"), "not read\n");
      await symlink("payload", join(root, "current"));
      expect((await inspect(root)).source_maps.skipped).toBe(0);
    },
  );
});

describe("ReleaseExposureReader packaged map identity", () => {
  it("keeps a malformed sibling map the selected script declares unresolved", async () => {
    const root = await createTestTempDirectory("rea-release-sibling-map-");
    await writeFile(
      join(root, "app.js"),
      "const value = 1;\n//# sourceMappingURL=assets.map\n",
    );
    await writeFile(join(root, "assets.map"), "not a map\n");
    const scanned = await inspect(join(root, "app.js"));
    expect(scanned.debug_companions).toEqual({ paths: [], skipped: 0 });
    expect(scanned.source_maps).toMatchObject({ embedded: 0, skipped: 1 });
  });

  it("keeps a named companion that a later script declares as its map", async () => {
    const root = await createTestTempDirectory("rea-release-named-companion-");
    await writeFile(join(root, "symbols.pdb"), "debug companion");
    await writeFile(
      join(root, "z.js"),
      "const value = 1;\n//# sourceMappingURL=symbols.pdb\n",
    );
    const scanned = await inspect(root);
    expect(scanned.debug_companions.paths).toEqual([
      expect.stringMatching(/symbols\.pdb$/u),
    ]);
  });

  it.each([
    ["app.js", { embedded: 0, unparsed: 1, skipped: 0 }],
    ["z.js", { embedded: 0, unparsed: 0, skipped: 1 }],
  ])(
    "keeps a packaged malformed assets.map that %s declares unresolved",
    async (script, expected) => {
      const root = await createTestTempDirectory("rea-release-packaged-map-");
      const archive = join(root, "app.asar");
      await writeFile(
        archive,
        asarArchive([
          {
            name: script,
            bytes: Buffer.from(
              "const value = 1;\n//# sourceMappingURL=assets.map\n",
            ),
          },
          { name: "assets.map", bytes: Buffer.from("not a map\n") },
        ]),
      );
      const scanned = await inspect(archive);
      expect(scanned.source_maps).toMatchObject(expected);
      expect(scanned.debug_companions.paths).toEqual([]);
    },
  );
});
