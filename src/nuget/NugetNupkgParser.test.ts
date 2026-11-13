import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ZipReader } from "@zip.js/zip.js";

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
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { NUPKG_LIMITATIONS, parseNugetNupkg } from "./NugetNupkgParser.js";
import {
  NugetNupkgCapacityFailure,
  NugetNupkgFormatFailure,
} from "./NugetNupkg.errors.js";

const defaults = inspectNugetNupkgInputSchema.parse({
  path: "/artifacts/Demo.Package.nupkg",
});

const artifactOf = (bytes: Uint8Array) => ({
  path: defaults.path,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
});

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
  ).rejects.toBeInstanceOf(NugetNupkgFormatFailure);
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
      constructor: NugetNupkgCapacityFailure,
      resource: "max_entries",
      maximum: 2,
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
    constructor: NugetNupkgCapacityFailure,
    resource: "max_nuspec_bytes",
    maximum: 1024,
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
      constructor: NugetNupkgCapacityFailure,
      resource: "max_nuspec_bytes",
      maximum: 1024,
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
