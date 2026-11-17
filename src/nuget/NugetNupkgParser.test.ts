import { ParseFailureError } from "../domain/parseFailure.js";
import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  TextReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from "@zip.js/zip.js";

import {
  inspectNugetNupkgInputSchema,
  nugetNupkgSchema,
} from "../domain/nuget/nupkg.js";
import {
  nugetNupkgAmbiguousNuspecFixture,
  nugetNupkgFixture,
  nugetNupkgMalformedNuspecFixture,
  nugetNupkgMissingNuspecFixture,
  ungroupedNuspec,
  NUPKG_NAME_ENCODING_CASES,
  nugetNupkgNameEncodingFixture,
} from "./NugetNupkg.fixture.js";
import {
  ArtifactReaderFailure,
  ZipArtifactReader,
} from "../resources/index.js";
import {
  NUPKG_LIMITATIONS,
  distinctTargetMatches,
  parseNugetNupkg,
} from "./NugetNupkgParser.js";

const defaults = inspectNugetNupkgInputSchema.parse({
  path: "/artifacts/Demo.Package.nupkg",
});

const artifactOf = (bytes: Uint8Array) => ({
  path: defaults.path,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
});

it.each(NUPKG_NAME_ENCODING_CASES)(
  "preserves $encoding filename provenance consistently with the shared ZIP reader",
  async (input) => {
    const bytes = await nugetNupkgNameEncodingFixture(input);
    const result = await parseNugetNupkg(bytes, artifactOf(bytes), defaults);
    expect(result.contents).toContainEqual(
      expect.objectContaining({
        name: input.name,
        path: input.name,
        role: "lib",
      }),
    );
    const root = await createTestTempDirectory("rea-nupkg-name-encoding-");
    const path = join(root, "package.nupkg");
    await writeFile(path, bytes);
    const reader = new ZipArtifactReader(path, "zip");
    try {
      const entries = [];
      for await (const entry of reader.entries()) entries.push(entry);
      const shared = entries.find((entry) => entry.path === input.name);
      expect(shared).toBeDefined();
      const warnings = result.limitations.filter((value) =>
        value.includes("CP437"),
      );
      if (input.uncertain) {
        expect(shared?.limitations).toEqual([
          expect.stringContaining(input.rawName.toString("hex")),
        ]);
        expect(warnings).toEqual([
          expect.stringContaining(shared!.limitations[0]!),
        ]);
        expect(warnings[0]).toContain(JSON.stringify(input.name));
      } else {
        expect(shared?.limitations).toEqual([]);
        expect(warnings).toEqual([]);
      }
    } finally {
      await reader.close();
    }
  },
);

it("redacts an unfollowed authority manifest target before package-path normalization", async () => {
  const bytes = await nugetNupkgFixture({
    relsTarget: "//user:password@feed.invalid/missing.nuspec?token=visible",
  });
  const result = await parseNugetNupkg(bytes, artifactOf(bytes), defaults);
  expect(JSON.stringify(result)).not.toContain("user:password");
  expect(result.limitations.join(" ")).toContain(
    "//feed.invalid/missing.nuspec?token=visible",
  );
  expect(result.nuspec?.source).toBe("root-nuspec");
});

it("keeps missing manifest target provenance separate from its normalized lookup", async () => {
  const bytes = await nugetNupkgFixture({
    relsTarget: "./part/../missing.nuspec",
  });
  const result = await parseNugetNupkg(bytes, artifactOf(bytes), defaults);
  expect(result.limitations).toContain(
    'OPC manifest relationship Target "./part/../missing.nuspec" is missing from the package; identity was not decoded from that path.',
  );
  expect(result.nuspec?.source).toBe("root-nuspec");
});

it.each([
  new Error("controlled opaque decoder failure"),
  { failure: "opaque" },
])(
  "preserves an unclassified ZIP failure without claiming malformed bytes: %j",
  async (cause) => {
    const bytes = await nugetNupkgFixture();
    const enumeration = vi
      .spyOn(ZipReader.prototype, "getEntriesGenerator")
      .mockImplementation(async function* () {
        throw cause;
      });
    try {
      await expect(
        parseNugetNupkg(bytes, artifactOf(bytes), defaults),
      ).rejects.toBe(cause);
    } finally {
      enumeration.mockRestore();
    }
  },
);

it("reads identity, license, repository, dependency groups and folder roles", async () => {
  const bytes = await nugetNupkgFixture();
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bytes, artifactOf(bytes), defaults),
  );
  expect(report.identity).toEqual({
    id: "Demo.Package",
    version: "1.2.3",
    authors: "Alice, Bob",
    description: "A tiny fixture package.",
  });
  expect(report.license).toEqual({ type: "expression", value: "MIT" });
  expect(report.repository).toEqual({
    type: "git",
    url: "https://example.invalid/demo",
    url_credentials_redacted: false,
    commit: "deadbeef",
    branch: "main",
  });
  expect(report.nuspec).toMatchObject({
    path: "Demo.Package.nuspec",
    source: "opc-relationship",
  });
  expect(report.dependency_groups).toEqual([
    {
      target_framework: "net8.0",
      dependencies: [
        {
          id: "Newtonsoft.Json",
          version: "13.0.1",
          include: null,
          exclude: null,
          development_dependency: null,
        },
      ],
    },
    {
      target_framework: "netstandard2.0",
      dependencies: [
        {
          id: "Newtonsoft.Json",
          version: "[12.0.3,13.0.0)",
          include: null,
          exclude: "Build,Analyzers",
          development_dependency: null,
        },
      ],
    },
  ]);
  expect(report.contents.map((entry) => [entry.name, entry.role])).toEqual(
    expect.arrayContaining([
      ["[Content_Types].xml", "opc"],
      ["_rels/.rels", "opc"],
      ["Demo.Package.nuspec", "nuspec"],
      ["lib/net8.0/Demo.dll", "lib"],
      ["runtimes/win-x64/native/demo.dll", "runtimes"],
    ]),
  );
  expect(report.coverage.status).toBe("complete");
  expect(report.limitations).toContain(NUPKG_LIMITATIONS.memberRoles);
});

it("keeps the stored ZIP member name beside its logical path", async () => {
  const bytes = await nugetNupkgFixture({
    extraMembers: { "./lib/net8.0/Extra.txt": "x" },
  });
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bytes, artifactOf(bytes), defaults),
  );
  expect(
    report.contents.find((entry) => entry.path === "lib/net8.0/Extra.txt"),
  ).toMatchObject({
    name: "./lib/net8.0/Extra.txt",
    path: "lib/net8.0/Extra.txt",
    role: "lib",
  });
  expect(
    report.contents.find((entry) => entry.path === "lib/net8.0/Demo.dll"),
  ).toMatchObject({ name: "lib/net8.0/Demo.dll" });
});

it("records ungrouped dependencies as a group with a null target framework", async () => {
  const bytes = await nugetNupkgFixture({
    nuspec: ungroupedNuspec,
    includeRels: false,
  });
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bytes, artifactOf(bytes), defaults),
  );
  expect(report.nuspec?.source).toBe("root-nuspec");
  expect(report.dependency_groups).toEqual([
    {
      target_framework: null,
      dependencies: [
        {
          id: "Foo",
          version: "1.0.0",
          include: "Compile",
          exclude: null,
          development_dependency: true,
        },
      ],
    },
  ]);
});

it("inventories a package with no .nuspec and leaves identity unknown", async () => {
  const bytes = await nugetNupkgMissingNuspecFixture();
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bytes, artifactOf(bytes), defaults),
  );
  expect(report.identity).toBeNull();
  expect(report.nuspec).toBeNull();
  expect(report.contents.some((entry) => entry.role === "lib")).toBe(true);
  expect(report.limitations).toContain(NUPKG_LIMITATIONS.noNuspec);
});

it("inventories a package with an ambiguous pair of root .nuspec members", async () => {
  const bytes = await nugetNupkgAmbiguousNuspecFixture();
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bytes, artifactOf(bytes), defaults),
  );
  expect(report.identity).toBeNull();
  expect(report.nuspec).toBeNull();
  expect(
    report.contents.filter((entry) => entry.role === "nuspec"),
  ).toHaveLength(2);
  expect(report.limitations).toContain(NUPKG_LIMITATIONS.ambiguousRootNuspec);
});

it("inventories a package whose .nuspec is not well-formed XML", async () => {
  const bytes = await nugetNupkgMalformedNuspecFixture();
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bytes, artifactOf(bytes), defaults),
  );
  expect(report.identity).toBeNull();
  expect(report.nuspec?.path).toBe("Demo.Package.nuspec");
  expect(report.limitations).toContain(NUPKG_LIMITATIONS.malformedNuspec);
});

it("refuses a non-ZIP file without claiming a package inventory", async () => {
  const bytes = Buffer.from("not a zip");
  await expect(
    parseNugetNupkg(bytes, artifactOf(bytes), defaults),
  ).rejects.toBeInstanceOf(ParseFailureError);
});

it("stops ZIP enumeration as soon as the entry budget is exceeded", async () => {
  const bytes = await nugetNupkgFixture({
    extraMembers: Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `content/f${String(index)}.txt`,
        "x",
      ]),
    ),
  });
  const original = ZipReader.prototype.getEntriesGenerator;
  let yielded = 0;
  const enumeration = vi
    .spyOn(ZipReader.prototype, "getEntriesGenerator")
    .mockImplementation(async function* (this: ZipReader<unknown>, options) {
      for await (const entry of original.call(this, options)) {
        yielded += 1;
        yield entry;
      }
      return true;
    });
  try {
    await expect(
      parseNugetNupkg(bytes, artifactOf(bytes), {
        ...defaults,
        max_entries: 2,
      }),
    ).rejects.toMatchObject({
      constructor: ParseFailureError,
      failure: {
        kind: "limit",
        limit: { name: "max_entries", maximum: 2, required: 3 },
      },
    });
    expect(yielded).toBe(3);
  } finally {
    enumeration.mockRestore();
  }
});

it("reports cancellation during a member read with the caller's reason", async () => {
  const bytes = await nugetNupkgFixture();
  const controller = new AbortController();
  const reason = { source: "caller-request", operation: "cancel" };
  const original = ZipReader.prototype.getEntriesGenerator;
  const enumeration = vi
    .spyOn(ZipReader.prototype, "getEntriesGenerator")
    .mockImplementation(async function* (this: ZipReader<unknown>, options) {
      yield* original.call(this, options);
      controller.abort(reason);
      return true;
    });
  try {
    const failure: unknown = await parseNugetNupkg(
      bytes,
      artifactOf(bytes),
      defaults,
      controller.signal,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    expect(failure).toMatchObject({ reason: "cancelled" });
    expect((failure as ArtifactReaderFailure).cancellation?.reason).toBe(
      reason,
    );
  } finally {
    enumeration.mockRestore();
  }
});

const largeRelsFixture = () =>
  nugetNupkgFixture({
    includeRels: false,
    extraMembers: { "_rels/.rels": " ".repeat(4096) },
  });

it("refuses an OPC relationships member larger than the metadata budget before reading it", async () => {
  const bytes = await largeRelsFixture();
  await expect(
    parseNugetNupkg(bytes, artifactOf(bytes), {
      ...defaults,
      max_nuspec_bytes: 1024,
    }),
  ).rejects.toMatchObject({
    constructor: ParseFailureError,
    failure: {
      kind: "limit",
      limit: { name: "max_nuspec_bytes", maximum: 1024 },
    },
  });
});

it("stops expanding an OPC relationships member at the budget when its declared size understates it", async () => {
  const bytes = await largeRelsFixture();
  const original = ZipReader.prototype.getEntriesGenerator;
  const enumeration = vi
    .spyOn(ZipReader.prototype, "getEntriesGenerator")
    .mockImplementation(async function* (this: ZipReader<unknown>, options) {
      for await (const entry of original.call(this, options)) {
        if (entry.filename === "_rels/.rels") entry.uncompressedSize = 1;
        yield entry;
      }
      return true;
    });
  try {
    await expect(
      parseNugetNupkg(bytes, artifactOf(bytes), {
        ...defaults,
        max_nuspec_bytes: 1024,
      }),
    ).rejects.toMatchObject({
      constructor: ParseFailureError,
      failure: {
        kind: "limit",
        limit: { name: "max_nuspec_bytes", maximum: 1024 },
      },
    });
  } finally {
    enumeration.mockRestore();
  }
});

it("leaves an external manifest relationship unfollowed even when it names a ZIP member", async () => {
  const bytes = await nugetNupkgFixture({
    includeRels: false,
    extraMembers: {
      "_rels/.rels": `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Type="http://schemas.microsoft.com/packaging/2010/07/manifest" Target="content/Other.nuspec" TargetMode="External" Id="R1" />
</Relationships>
`,
      "content/Other.nuspec": ungroupedNuspec,
    },
  });
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bytes, artifactOf(bytes), defaults),
  );
  expect(report.nuspec).toMatchObject({
    path: "Demo.Package.nuspec",
    source: "root-nuspec",
  });
  expect(report.identity?.id).toBe("Demo.Package");
  expect(report.limitations).toContain(
    'OPC manifest relationship Target "content/Other.nuspec" is external and was not followed.',
  );
});

const manifestRels = (target: string) => `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Type="http://schemas.microsoft.com/packaging/2010/07/manifest" Target="${target}" Id="R1" />
</Relationships>
`;

it.for(["manifests/./Actual.nuspec", "/manifests/extra/../Actual.nuspec"])(
  "resolves dot segments in the manifest relationship Target %s",
  async (target) => {
    const bytes = await nugetNupkgFixture({
      includeRels: false,
      extraMembers: {
        "_rels/.rels": manifestRels(target),
        "manifests/Actual.nuspec": ungroupedNuspec,
      },
    });
    const report = nugetNupkgSchema.parse(
      await parseNugetNupkg(bytes, artifactOf(bytes), defaults),
    );
    expect(report.nuspec).toMatchObject({
      path: "manifests/Actual.nuspec",
      source: "opc-relationship",
    });
    expect(report.identity?.id).toBe("Ungrouped.Package");
  },
);

it("does not follow a manifest relationship Target that resolves above the package root", async () => {
  const bytes = await nugetNupkgFixture({
    includeRels: false,
    extraMembers: { "_rels/.rels": manifestRels("../Actual.nuspec") },
  });
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bytes, artifactOf(bytes), defaults),
  );
  expect(report.limitations).toContain(
    'OPC manifest relationship Target "../Actual.nuspec" leaves the package and was not followed.',
  );
});

const utf16Nuspec = (littleEndian: boolean) => {
  const text = ungroupedNuspec.replace('encoding="utf-8"', 'encoding="utf-16"');
  const bytes = new Uint8Array(2 + text.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfeff, littleEndian);
  for (let index = 0; index < text.length; index += 1)
    view.setUint16(2 + index * 2, text.charCodeAt(index), littleEndian);
  return bytes;
};

it.for([true, false])(
  "decodes a BOM-marked UTF-16 .nuspec (little-endian %s)",
  async (littleEndian) => {
    const bytes = await nugetNupkgFixture({
      nuspecBytes: utf16Nuspec(littleEndian),
    });
    const report = nugetNupkgSchema.parse(
      await parseNugetNupkg(bytes, artifactOf(bytes), defaults),
    );
    expect(report.identity?.id).toBe("Ungrouped.Package");
    expect(report.dependency_groups).not.toEqual([]);
  },
);

it("keeps a Zstandard dictionary refusal as an unsupported layout instead of a malformed package", async () => {
  const bytes = await nugetNupkgFixture();
  const refusal = Object.assign(new Error("Dictionary mismatch"), {
    code: "ZSTD_error_dictionary_wrong",
  });
  const original = ZipReader.prototype.getEntriesGenerator;
  const enumeration = vi
    .spyOn(ZipReader.prototype, "getEntriesGenerator")
    .mockImplementation(async function* (this: ZipReader<unknown>, options) {
      for await (const entry of original.call(this, options)) {
        if (entry.filename === "Demo.Package.nuspec" && !entry.directory) {
          entry.compressionMethod = 93;
          entry.getData = () => Promise.reject(refusal);
        }
        yield entry;
      }
      return true;
    });
  try {
    const failure: unknown = await parseNugetNupkg(
      bytes,
      artifactOf(bytes),
      defaults,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ParseFailureError);
    expect(failure).toMatchObject({ failure: { kind: "unsupported" } });
    expect((failure as Error).message).toContain("Zstandard dictionary");
    expect(((failure as Error).cause as ArtifactReaderFailure).cause).toBe(
      refusal,
    );
  } finally {
    enumeration.mockRestore();
  }
});

it("keeps a Zstandard decoder window refusal as a memory limit instead of a malformed package", async () => {
  const bytes = await nugetNupkgFixture();
  const refusal = Object.assign(new Error("Frame requires too much memory"), {
    code: "ZSTD_error_frameParameter_windowTooLarge",
  });
  const original = ZipReader.prototype.getEntriesGenerator;
  const enumeration = vi
    .spyOn(ZipReader.prototype, "getEntriesGenerator")
    .mockImplementation(async function* (this: ZipReader<unknown>, options) {
      for await (const entry of original.call(this, options)) {
        if (entry.filename === "Demo.Package.nuspec" && !entry.directory) {
          entry.compressionMethod = 93;
          entry.getData = () => Promise.reject(refusal);
        }
        yield entry;
      }
      return true;
    });
  try {
    const failure: unknown = await parseNugetNupkg(
      bytes,
      artifactOf(bytes),
      defaults,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    expect(failure).toMatchObject({ reason: "limit", boundary: "memory" });
    expect((failure as ArtifactReaderFailure).cause).toBe(refusal);
  } finally {
    enumeration.mockRestore();
  }
});

it("reads manifest text written as CDATA and as mixed text and CDATA", async () => {
  const bytes = await nugetNupkgFixture({
    nuspec: ungroupedNuspec
      .replace(
        "<id>Ungrouped.Package</id>",
        "<id><![CDATA[Ungrouped.Package]]></id>",
      )
      .replace(
        /<description>[^<]*<\/description>/u,
        "<description>A <![CDATA[& B]]> C</description>",
      ),
  });
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bytes, artifactOf(bytes), defaults),
  );
  expect(report.identity).toMatchObject({
    id: "Ungrouped.Package",
    description: "A & B C",
  });
});

it.for(["constructor/file.txt", "__proto__/file.txt", "toString/file.txt"])(
  "keeps payload folder %s at the unknown role",
  async (name) => {
    const bytes = await nugetNupkgFixture({ extraMembers: { [name]: "x" } });
    const report = nugetNupkgSchema.parse(
      await parseNugetNupkg(bytes, artifactOf(bytes), defaults),
    );
    expect(report.contents.find((entry) => entry.path === name)?.role).toBe(
      "unknown",
    );
  },
);

it("leaves identity unknown when the manifest relationship matches case-variant members", async () => {
  const bytes = await nugetNupkgFixture({
    includeRels: false,
    nuspecName: "First.nuspec",
    extraMembers: {
      "_rels/.rels": manifestRels("/FIRST.nuspec"),
      "first.nuspec": ungroupedNuspec,
    },
  });
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bytes, artifactOf(bytes), defaults),
  );
  expect(report.identity).toBeNull();
  expect(report.nuspec).toBeNull();
  expect(report.limitations).toContain(
    "OPC manifest relationships resolve to more than one .nuspec ZIP member; identity was not decoded.",
  );
});

it("reports an encrypted manifest above the metadata budget without decoding it", async () => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("Demo.Package.nuspec", new TextReader(ungroupedNuspec), {
    password: "fixture",
    level: 0,
  });
  const bytes = await writer.close();
  const input = inspectNugetNupkgInputSchema.parse({
    path: defaults.path,
    max_nuspec_bytes: 1,
  });
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bytes, artifactOf(bytes), input),
  );
  expect(report.nuspec).toEqual({
    path: "Demo.Package.nuspec",
    bytes: null,
    source: "root-nuspec",
  });
  expect(report.coverage.examined_nuspec_bytes).toBe(0);
  expect(report.contents[0]?.encrypted).toBe(true);
});

it("follows no relationships when two members normalize to _rels/.rels", async () => {
  const bytes = await nugetNupkgFixture({
    extraMembers: {
      "./_rels/.rels": manifestRels("/content/Other.nuspec"),
      "content/Other.nuspec": ungroupedNuspec,
    },
  });
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bytes, artifactOf(bytes), defaults),
  );
  expect(report.nuspec).toMatchObject({
    path: "Demo.Package.nuspec",
    source: "root-nuspec",
  });
  expect(report.limitations).toContain(
    "More than one ZIP member is the OPC relationships part; relationships were not followed and the .nuspec was selected by ZIP name when possible.",
  );
});

it("reports unknown coverage when the central directory leaves bytes unaccounted", async () => {
  const packed = Buffer.from(await nugetNupkgFixture());
  // Splice opaque bytes in front of the central directory and move the
  // end-of-central-directory offset past them, as an omitted local entry would.
  const eocd = packed.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const directory = packed.readUInt32LE(eocd + 16);
  const hidden = Buffer.alloc(64, 0x41);
  const bytes = Buffer.concat([
    packed.subarray(0, directory),
    hidden,
    packed.subarray(directory),
  ]);
  bytes.writeUInt32LE(directory + hidden.length, eocd + hidden.length + 16);
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bytes, artifactOf(bytes), defaults),
  );
  expect(report.coverage.status).toBe("unknown");
  expect(report.identity?.id).toBe("Demo.Package");
  expect(
    report.limitations.some((line) =>
      line.includes("does not account for 64 byte"),
    ),
  ).toBe(true);
});

it("stops resolving manifest targets once a second distinct member is found", () => {
  const bucket = Array.from({ length: 10_000 }, (_, index) => ({ index }));
  const match = vi.fn((_target: string) => bucket);
  const targets = Array.from(
    { length: 10_000 },
    (_, index) => `T${index}.nuspec`,
  );
  expect(distinctTargetMatches(targets, match)).toEqual([bucket[0], bucket[1]]);
  expect(match).toHaveBeenCalledTimes(1);
});

it("keeps one member when every manifest target resolves to it", () => {
  const member = { name: "Only.nuspec" };
  const match = vi.fn((_target: string) => [member]);
  const targets = Array.from({ length: 1_000 }, () => "ONLY.nuspec");
  expect(distinctTargetMatches(targets, match)).toEqual([member]);
  expect(match).toHaveBeenCalledTimes(1_000);
});
