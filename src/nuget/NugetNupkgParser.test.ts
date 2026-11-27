import { ParseFailureError } from "../domain/parseFailure.js";
import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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
} from "./NugetNupkg.fixture.js";
import { ArtifactReaderFailure } from "../resources/index.js";
import { NUPKG_LIMITATIONS, parseNugetNupkg } from "./NugetNupkgParser.js";
import { bufferByteSource } from "../domain/byteSource.js";

const defaults = inspectNugetNupkgInputSchema.parse({
  path: "/artifacts/Demo.Package.nupkg",
});

const artifactOf = (bytes: Uint8Array) => ({
  path: defaults.path,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
});

it("redacts an unfollowed authority manifest target before package-path normalization", async () => {
  const bytes = await nugetNupkgFixture({
    relsTarget: "//user:password@feed.invalid/missing.nuspec?token=visible",
  });
  const result = await parseNugetNupkg(
    bufferByteSource(bytes),
    artifactOf(bytes),
    defaults,
  );
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
  const result = await parseNugetNupkg(
    bufferByteSource(bytes),
    artifactOf(bytes),
    defaults,
  );
  expect(result.limitations).toContain(
    'OPC manifest relationship Target "./part/../missing.nuspec" is missing from the package; identity was not decoded from that path.',
  );
  expect(result.nuspec?.source).toBe("root-nuspec");
});

it("preserves a non-Error ZIP failure without classifying the package as malformed", async () => {
  const cause = { failure: "opaque" };
  const bytes = await nugetNupkgFixture();
  const enumeration = vi
    .spyOn(ZipReader.prototype, "getEntriesGenerator")
    .mockImplementation(async function* () {
      throw cause;
    });
  try {
    await expect(
      parseNugetNupkg(bufferByteSource(bytes), artifactOf(bytes), defaults),
    ).rejects.toBe(cause);
  } finally {
    enumeration.mockRestore();
  }
});

it("reads identity, license, repository, dependency groups and folder roles", async () => {
  const bytes = await nugetNupkgFixture();
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bufferByteSource(bytes), artifactOf(bytes), defaults),
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
  expect(report.limitations).not.toContainEqual(
    expect.stringContaining("beside <group> elements were omitted"),
  );
});

it("keeps the stored ZIP member name beside its logical path", async () => {
  const bytes = await nugetNupkgFixture({
    extraMembers: { "./lib/net8.0/Extra.txt": "x" },
  });
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bufferByteSource(bytes), artifactOf(bytes), defaults),
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
    await parseNugetNupkg(bufferByteSource(bytes), artifactOf(bytes), defaults),
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
  expect(report.limitations).not.toContain(
    NUPKG_LIMITATIONS.ungroupedBesideGroups(1),
  );
});

const NET8_GROUP =
  '<group targetFramework="net8.0"><dependency id="Bar" version="2.0.0" /></group>';

it.for([
  ["in one <dependencies> element", `<dependencies>\n      ${NET8_GROUP}`],
  [
    "in a separate <dependencies> element",
    `<dependencies>${NET8_GROUP}</dependencies>\n    <dependencies>`,
  ],
])(
  "omits ungrouped dependencies beside groups %s, as NuGet does",
  async ([, opening]) => {
    const bytes = await nugetNupkgFixture({
      nuspec: ungroupedNuspec.replace("<dependencies>", opening!),
      includeRels: false,
    });
    const report = nugetNupkgSchema.parse(
      await parseNugetNupkg(
        bufferByteSource(bytes),
        artifactOf(bytes),
        defaults,
      ),
    );
    expect(report.dependency_groups).toEqual([
      {
        target_framework: "net8.0",
        dependencies: [
          {
            id: "Bar",
            version: "2.0.0",
            include: null,
            exclude: null,
            development_dependency: null,
          },
        ],
      },
    ]);
    expect(report.limitations).toContain(
      NUPKG_LIMITATIONS.ungroupedBesideGroups(1),
    );
  },
);

it("inventories a package with no .nuspec and leaves identity unknown", async () => {
  const bytes = await nugetNupkgMissingNuspecFixture();
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bufferByteSource(bytes), artifactOf(bytes), defaults),
  );
  expect(report.identity).toBeNull();
  expect(report.nuspec).toBeNull();
  expect(report.contents.some((entry) => entry.role === "lib")).toBe(true);
  expect(report.limitations).toContain(NUPKG_LIMITATIONS.noNuspec);
});

it("inventories a package with an ambiguous pair of root .nuspec members", async () => {
  const bytes = await nugetNupkgAmbiguousNuspecFixture();
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bufferByteSource(bytes), artifactOf(bytes), defaults),
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
    await parseNugetNupkg(bufferByteSource(bytes), artifactOf(bytes), defaults),
  );
  expect(report.identity).toBeNull();
  expect(report.nuspec?.path).toBe("Demo.Package.nuspec");
  expect(report.limitations).toContain(NUPKG_LIMITATIONS.malformedNuspec);
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
      parseNugetNupkg(bufferByteSource(bytes), artifactOf(bytes), {
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
      for await (const entry of original.call(this, options)) {
        if (!entry.directory && entry.filename === "_rels/.rels") {
          const getData = entry.getData.bind(entry);
          entry.getData = (writer, options) => {
            controller.abort(reason);
            return getData(writer, options);
          };
        }
        yield entry;
      }
      return true;
    });
  try {
    const failure: unknown = await parseNugetNupkg(
      bufferByteSource(bytes),
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

it.each(["before a visible row", "at enumeration completion"] as const)(
  "reports cancellation %s at the selected ZIP boundary",
  async (phase) => {
    const bytes = await nugetNupkgFixture();
    const controller = new AbortController();
    const reason = { caller: "stop ZIP inventory" };
    const original = ZipReader.prototype.getEntriesGenerator;
    const listed: string[] = [];
    const reads: string[] = [];
    const enumeration = vi
      .spyOn(ZipReader.prototype, "getEntriesGenerator")
      .mockImplementation(async function* (this: ZipReader<unknown>, options) {
        for await (const entry of original.call(this, options)) {
          listed.push(entry.filename);
          if (!entry.directory) {
            const read = entry.getData.bind(entry);
            entry.getData = (writer, readOptions) => {
              reads.push(entry.filename);
              return read(writer, readOptions);
            };
          }
          if (phase === "before a visible row") controller.abort(reason);
          yield entry;
        }
        if (phase === "at enumeration completion") controller.abort(reason);
        return true;
      });
    try {
      const failure: unknown = await parseNugetNupkg(
        bufferByteSource(bytes),
        artifactOf(bytes),
        defaults,
        controller.signal,
      ).catch((cause: unknown) => cause);
      if (!(failure instanceof ArtifactReaderFailure))
        throw new Error("expected inventory cancellation");
      expect(failure.reason).toBe("cancelled");
      expect(failure.cancellation?.reason).toBe(reason);
      expect(listed).toEqual(
        phase === "before a visible row"
          ? ["[Content_Types].xml"]
          : [
              "[Content_Types].xml",
              "_rels/.rels",
              "Demo.Package.nuspec",
              "lib/net8.0/Demo.dll",
              "runtimes/win-x64/native/demo.dll",
            ],
      );
      expect(reads).toEqual([]);
    } finally {
      enumeration.mockRestore();
    }
  },
);

it("keeps the ZIP directory failure when cancellation reuses that error", async () => {
  // A local header signature without a central directory is not a valid ZIP.
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const controller = new AbortController();
  const original = ZipReader.prototype.getEntriesGenerator;
  const enumeration = vi
    .spyOn(ZipReader.prototype, "getEntriesGenerator")
    .mockImplementation(async function* (this: ZipReader<unknown>, options) {
      try {
        return yield* original.call(this, options);
      } catch (cause: unknown) {
        controller.abort(cause);
        throw cause;
      }
    });
  try {
    const failure: unknown = await parseNugetNupkg(
      bufferByteSource(bytes),
      artifactOf(bytes),
      defaults,
      controller.signal,
    ).catch((cause: unknown) => cause);
    if (!(failure instanceof ParseFailureError))
      throw new Error("expected malformed ZIP failure", { cause: failure });
    expect(failure.failure.kind).toBe("malformed");
    expect(failure.cause).toBeInstanceOf(ArtifactReaderFailure);
    expect((failure.cause as ArtifactReaderFailure).cause).toBe(
      controller.signal.reason,
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

it.each([
  { phase: "declared size", required: 4096, reads: 0, appended: [] },
  { phase: "decoder initialization", required: 4096, reads: 1, appended: [] },
  { phase: "each decoder chunk", required: 1280, reads: 1, appended: [768] },
])(
  "enforces the relationships metadata budget at $phase",
  async ({ phase, required, reads, appended }) => {
    const bytes = await largeRelsFixture();
    const original = ZipReader.prototype.getEntriesGenerator;
    let memberReads = 0;
    const initialize = vi.spyOn(Uint8ArrayWriter.prototype, "init");
    const sink = vi.spyOn(Uint8ArrayWriter.prototype, "writeUint8Array");
    const enumeration = vi
      .spyOn(ZipReader.prototype, "getEntriesGenerator")
      .mockImplementation(async function* (this: ZipReader<unknown>, options) {
        for await (const entry of original.call(this, options)) {
          if (!entry.directory && entry.filename === "_rels/.rels") {
            if (phase !== "declared size") entry.uncompressedSize = 768;
            const realRead = entry.getData.bind(entry);
            entry.getData = async (writer, readOptions) => {
              memberReads += 1;
              if (phase !== "each decoder chunk")
                return realRead(writer, readOptions);
              if (
                !(writer instanceof Uint8ArrayWriter) ||
                writer.init === undefined
              )
                throw new Error("Expected the bounded metadata writer");
              // The ZIP codec normally enforces its own size. Offer two chunks
              // directly to REA's writer to exercise its independent charge.
              await writer.init(768);
              await writer.writeUint8Array(new Uint8Array(768));
              await writer.writeUint8Array(new Uint8Array(512));
              throw new Error(
                "Expected the second offered chunk to be refused",
              );
            };
          }
          yield entry;
        }
        return true;
      });
    try {
      await expect(
        parseNugetNupkg(bufferByteSource(bytes), artifactOf(bytes), {
          ...defaults,
          max_nuspec_bytes: 1024,
        }),
      ).rejects.toMatchObject({
        constructor: ParseFailureError,
        failure: {
          kind: "limit",
          limit: { name: "max_nuspec_bytes", maximum: 1024, required },
        },
      });
      expect(memberReads).toBe(reads);
      expect(initialize.mock.calls.map(([size]) => size)).toEqual(appended);
      expect(sink.mock.calls.map(([chunk]) => chunk.byteLength)).toEqual(
        appended,
      );
    } finally {
      sink.mockRestore();
      initialize.mockRestore();
      enumeration.mockRestore();
    }
  },
);

it.each([
  { mode: "External", selected: false, limitation: "is external" },
  { mode: "Internal", selected: true, limitation: null },
  { mode: "Unknown", selected: false, limitation: "has an invalid TargetMode" },
  { mode: "", selected: false, limitation: "has an invalid TargetMode" },
  {
    mode: "internal",
    selected: false,
    limitation: "has an invalid TargetMode",
  },
])(
  "uses the declared OPC manifest TargetMode $mode",
  async ({ mode, selected, limitation }) => {
    const bytes = await nugetNupkgFixture({
      includeRels: false,
      extraMembers: {
        "_rels/.rels": `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Type="http://schemas.microsoft.com/packaging/2010/07/manifest" Target="content/Other.nuspec" TargetMode="${mode}" Id="R1" />
</Relationships>
`,
        "content/Other.nuspec": ungroupedNuspec,
      },
    });
    const report = nugetNupkgSchema.parse(
      await parseNugetNupkg(
        bufferByteSource(bytes),
        artifactOf(bytes),
        defaults,
      ),
    );
    expect(report.nuspec).toMatchObject({
      path: selected ? "content/Other.nuspec" : "Demo.Package.nuspec",
      source: selected ? "opc-relationship" : "root-nuspec",
    });
    expect(report.identity?.id).toBe(
      selected ? "Ungrouped.Package" : "Demo.Package",
    );
    if (limitation !== null)
      expect(report.limitations).toContain(
        `OPC manifest relationship Target "content/Other.nuspec" ${limitation} and was not followed.`,
      );
  },
);

const manifestRels = (
  ...targets: string[]
) => `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${targets.map((target, index) => `<Relationship Type="http://schemas.microsoft.com/packaging/2010/07/manifest" Target="${target}" Id="R${index + 1}" />`).join("\n  ")}
</Relationships>
`;

it("uses the root nuspec when an unrelated relationship ends in /manifest", async () => {
  const bytes = await nugetNupkgFixture({
    includeRels: false,
    extraMembers: {
      "_rels/.rels": manifestRels("content/Other.nuspec").replace(
        "http://schemas.microsoft.com/packaging/2010/07/manifest",
        "https://example.invalid/manifest",
      ),
      "content/Other.nuspec": ungroupedNuspec,
    },
  });
  const report = await parseNugetNupkg(
    bufferByteSource(bytes),
    artifactOf(bytes),
    defaults,
  );
  expect(report.nuspec).toMatchObject({
    path: "Demo.Package.nuspec",
    source: "root-nuspec",
  });
  expect(report.identity?.id).toBe("Demo.Package");
});

const opcRelationshipNamespace =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const nestedManifestRels = manifestRels("content/Other.nuspec");

it.each([
  {
    label: "foreign root namespace",
    rels: nestedManifestRels.replace(
      opcRelationshipNamespace,
      "urn:sample:foreign",
    ),
    selected: false,
  },
  {
    label: "unqualified root and relationship",
    rels: nestedManifestRels.replace(
      ` xmlns="${opcRelationshipNamespace}"`,
      "",
    ),
    selected: false,
  },
  {
    label: "foreign child namespace",
    rels: nestedManifestRels.replace(
      "<Relationship Type=",
      '<Relationship xmlns="urn:sample:foreign" Type=',
    ),
    selected: false,
  },
  {
    label: "prefixed OPC elements",
    rels: nestedManifestRels
      .replace("xmlns=", "xmlns:opc=")
      .replaceAll("<Relationships", "<opc:Relationships")
      .replaceAll("</Relationships", "</opc:Relationships")
      .replace("<Relationship Type=", "<opc:Relationship Type="),
    selected: true,
  },
  {
    label: "valid relationship beside a foreign child",
    rels: nestedManifestRels.replace(
      "</Relationships>",
      '<Relationship xmlns="urn:sample:foreign" Type="http://schemas.microsoft.com/packaging/2010/07/manifest" Target="Demo.Package.nuspec" Id="Foreign"/></Relationships>',
    ),
    selected: true,
  },
])(
  "recognizes OPC manifest authority by expanded XML name ($label)",
  async ({ rels, selected }) => {
    const bytes = await nugetNupkgFixture({
      includeRels: false,
      extraMembers: {
        "_rels/.rels": rels,
        "content/Other.nuspec": ungroupedNuspec,
      },
    });
    const report = await parseNugetNupkg(
      bufferByteSource(bytes),
      artifactOf(bytes),
      defaults,
    );
    expect(report.nuspec).toMatchObject({
      path: selected ? "content/Other.nuspec" : "Demo.Package.nuspec",
      source: selected ? "opc-relationship" : "root-nuspec",
    });
    expect(report.identity?.id).toBe(
      selected ? "Ungrouped.Package" : "Demo.Package",
    );
  },
);

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
      await parseNugetNupkg(
        bufferByteSource(bytes),
        artifactOf(bytes),
        defaults,
      ),
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
    await parseNugetNupkg(bufferByteSource(bytes), artifactOf(bytes), defaults),
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
      await parseNugetNupkg(
        bufferByteSource(bytes),
        artifactOf(bytes),
        defaults,
      ),
    );
    expect(report.identity?.id).toBe("Ungrouped.Package");
    expect(report.dependency_groups).not.toEqual([]);
  },
);

it.each([
  {
    decoderCode: "ZSTD_error_dictionary_wrong",
    detail: "Dictionary mismatch",
    classification: {
      constructor: ParseFailureError,
      failure: { kind: "unsupported" },
      message: expect.stringContaining("Zstandard dictionary"),
    },
  },
  {
    decoderCode: "ZSTD_error_frameParameter_windowTooLarge",
    detail: "Frame requires too much memory",
    classification: {
      constructor: ArtifactReaderFailure,
      reason: "limit",
      boundary: "memory",
    },
  },
])(
  "retains the typed classification and original Zstandard cause for $decoderCode",
  async ({ decoderCode, detail, classification }) => {
    const bytes = await nugetNupkgFixture();
    const refusal = Object.assign(new Error(detail), { code: decoderCode });
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
        bufferByteSource(bytes),
        artifactOf(bytes),
        defaults,
      ).catch((cause: unknown) => cause);
      expect(failure).toMatchObject(classification);
      const wrapped =
        failure instanceof ParseFailureError ? failure.cause : failure;
      if (!(wrapped instanceof ArtifactReaderFailure)) throw failure;
      expect(wrapped.cause).toBe(refusal);
    } finally {
      enumeration.mockRestore();
    }
  },
);

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
    await parseNugetNupkg(bufferByteSource(bytes), artifactOf(bytes), defaults),
  );
  expect(report.identity).toMatchObject({
    id: "Ungrouped.Package",
    description: "A & B C",
  });
});

it("applies XML end-of-line handling to manifest text", async () => {
  const bytes = await nugetNupkgFixture({
    nuspec: ungroupedNuspec
      .replaceAll("\n", "\r\n")
      .replace(
        /<description>[^<]*<\/description>/u,
        "<description>First line.\r\nSecond line.\rThird line.</description>",
      ),
  });
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bufferByteSource(bytes), artifactOf(bytes), defaults),
  );
  expect(report.identity?.description).toBe(
    "First line.\nSecond line.\nThird line.",
  );
});

it.for(["constructor/file.txt", "__proto__/file.txt", "toString/file.txt"])(
  "keeps payload folder %s at the unknown role",
  async (name) => {
    const bytes = await nugetNupkgFixture({ extraMembers: { [name]: "x" } });
    const report = nugetNupkgSchema.parse(
      await parseNugetNupkg(
        bufferByteSource(bytes),
        artifactOf(bytes),
        defaults,
      ),
    );
    expect(report.contents.find((entry) => entry.path === name)?.role).toBe(
      "unknown",
    );
  },
);

it.each(["/FIRST.nuspec", "/First.nuspec", "/first.nuspec"])(
  "leaves identity unknown when OPC target %s matches case-variant members",
  async (target) => {
    const bytes = await nugetNupkgFixture({
      includeRels: false,
      nuspecName: "First.nuspec",
      extraMembers: {
        "_rels/.rels": manifestRels(target),
        "first.nuspec": ungroupedNuspec,
      },
    });
    const report = nugetNupkgSchema.parse(
      await parseNugetNupkg(
        bufferByteSource(bytes),
        artifactOf(bytes),
        defaults,
      ),
    );
    expect(report.identity).toBeNull();
    expect(report.nuspec).toBeNull();
    expect(report.coverage).toMatchObject({
      status: "complete",
      examined_nuspec_bytes: 0,
    });
    expect(report.contents.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(["First.nuspec", "first.nuspec"]),
    );
    expect(report.limitations).toContain(
      "OPC manifest relationships resolve to more than one .nuspec ZIP member; identity was not decoded.",
    );
  },
);

it.each([
  {
    target: "/CONTENT/É.nuspec",
    source: "opc-relationship",
    id: "Ungrouped.Package",
  },
  { target: "/CONTENT/é.nuspec", source: "root-nuspec", id: "Demo.Package" },
])(
  "matches only ASCII case variants in an OPC target $target",
  async ({ target, source, id }) => {
    const bytes = await nugetNupkgFixture({
      includeRels: false,
      extraMembers: {
        "_rels/.rels": manifestRels(target),
        "content/É.nuspec": ungroupedNuspec,
      },
    });
    const report = await parseNugetNupkg(
      bufferByteSource(bytes),
      artifactOf(bytes),
      defaults,
    );
    expect(report.nuspec?.source).toBe(source);
    expect(report.identity?.id).toBe(id);
    const warnings = report.limitations.filter((line) =>
      line.includes("case-insensitive ZIP name"),
    );
    expect(warnings).toEqual(
      source === "opc-relationship"
        ? [
            "The OPC manifest relationship matched a .nuspec member by case-insensitive ZIP name.",
          ]
        : [],
    );
  },
);

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
    await parseNugetNupkg(bufferByteSource(bytes), artifactOf(bytes), input),
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
    await parseNugetNupkg(bufferByteSource(bytes), artifactOf(bytes), defaults),
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
    await parseNugetNupkg(bufferByteSource(bytes), artifactOf(bytes), defaults),
  );
  expect(report.coverage.status).toBe("unknown");
  expect(report.identity?.id).toBe("Demo.Package");
  expect(
    report.limitations.some((line) =>
      line.includes("does not account for 64 byte"),
    ),
  ).toBe(true);
});

it("follows multiple relationship spellings of a single physical manifest", async () => {
  const bytes = await nugetNupkgFixture({
    includeRels: false,
    extraMembers: {
      "_rels/.rels": manifestRels(
        "/CONTENT/OTHER.nuspec",
        "/content/./Other.nuspec",
      ),
      "content/Other.nuspec": ungroupedNuspec,
    },
  });
  const report = await parseNugetNupkg(
    bufferByteSource(bytes),
    artifactOf(bytes),
    defaults,
  );
  expect(report.nuspec).toMatchObject({
    path: "content/Other.nuspec",
    source: "opc-relationship",
  });
  expect(report.identity?.id).toBe("Ungrouped.Package");
  expect(report.limitations).not.toContainEqual(
    expect.stringContaining("case-insensitive ZIP name"),
  );
});

it("keeps a foreign group from suppressing ungrouped NuGet dependencies", async () => {
  const bytes = await nugetNupkgFixture({
    nuspec: `<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd" xmlns:ext="urn:example">
      <metadata>
        <id>Demo.Package</id><version>1.0.0</version>
        <dependencies>
          <ext:group targetFramework="net8.0"><ext:dependency id="Extension" /></ext:group>
          <dependency id="Declared" version="1.0" />
        </dependencies>
      </metadata>
    </package>`,
  });
  const result = await parseNugetNupkg(
    bufferByteSource(bytes),
    artifactOf(bytes),
    defaults,
  );
  expect(result.dependency_groups).toMatchObject([
    { target_framework: null, dependencies: [{ id: "Declared" }] },
  ]);
});

it("selects the first nonempty leaf for indexed publisher metadata", async () => {
  const bytes = await nugetNupkgFixture({
    nuspec: ungroupedNuspec
      .replace(
        "<authors>Casey</authors>",
        '<authors>Wrong <team>nested</team></authors><authors/><x:Authors xmlns:x="urn:extension">First publisher</x:Authors><authors>Later publisher</authors>',
      )
      .replace(
        "<description>Ungrouped dependencies.</description>",
        "<Description>Published description</Description>",
      )
      .replace(
        "<id>Ungrouped.Package</id>",
        "<ID>Ignored</ID><id>Ungrouped.Package</id>",
      ),
  });
  const report = await parseNugetNupkg(
    bufferByteSource(bytes),
    artifactOf(bytes),
    defaults,
  );
  expect(report.identity).toMatchObject({
    id: "Ungrouped.Package",
    authors: "First publisher",
    description: "Published description",
  });
});

it.each([
  ["<authors> </authors>", "Later"],
  ["<authors><![CDATA[ ]]></authors>", null],
  ['<authors xml:space="preserve"> </authors>', null],
  ['<authors xml:space="preserve">  Casey  </authors>', "  Casey  "],
])("keeps NuGet's first eligible publisher for %s", async (first, expected) => {
  const bytes = await nugetNupkgFixture({
    nuspec: ungroupedNuspec.replace(
      "<authors>Casey</authors>",
      first + "<authors>Later</authors>",
    ),
  });
  const report = await parseNugetNupkg(
    bufferByteSource(bytes),
    artifactOf(bytes),
    defaults,
  );
  expect(report.identity?.authors).toBe(expected);
});

it("inherits xml:space for publisher text until the field resets it", async () => {
  const bytes = await nugetNupkgFixture({
    nuspec: ungroupedNuspec
      .replace("<package ", '<package xml:space="preserve" ')
      .replace("<authors>Casey", '<authors xml:space="default">  Casey  ')
      .replace("Ungrouped dependencies.", "    first\r\n    second\r\n"),
  });
  const report = await parseNugetNupkg(
    bufferByteSource(bytes),
    artifactOf(bytes),
    defaults,
  );
  expect(report.identity).toMatchObject({
    authors: "Casey",
    description: "    first\n    second\n",
  });
});
