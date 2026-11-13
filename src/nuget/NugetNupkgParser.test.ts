import { expect, it } from "vitest";
import { createHash } from "node:crypto";

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
import { parseNugetNupkg } from "./NugetNupkgParser.js";
import { NugetNupkgFormatFailure } from "./NugetNupkg.errors.js";

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
  expect(report.limitations).toEqual(
    expect.arrayContaining([
      "Member roles are derived from NuGet folder conventions in the ZIP names; they are not restore-time asset selection.",
    ]),
  );
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
  expect(report.limitations).toEqual(
    expect.arrayContaining(["No .nuspec was selected."]),
  );
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
  expect(report.limitations).toEqual(
    expect.arrayContaining([
      "Multiple root .nuspec members are present; identity was not decoded.",
    ]),
  );
});

it("inventories a package whose .nuspec is not well-formed XML", async () => {
  const bytes = await nugetNupkgMalformedNuspecFixture();
  const report = nugetNupkgSchema.parse(
    await parseNugetNupkg(bytes, artifactOf(bytes), defaults),
  );
  expect(report.identity).toBeNull();
  expect(report.nuspec?.path).toBe("Demo.Package.nuspec");
  expect(report.limitations).toEqual(
    expect.arrayContaining(["The selected .nuspec is not well-formed XML."]),
  );
});

it("refuses a non-ZIP file without claiming a package inventory", async () => {
  const bytes = Buffer.from("not a zip");
  await expect(
    parseNugetNupkg(bytes, artifactOf(bytes), defaults),
  ).rejects.toBeInstanceOf(NugetNupkgFormatFailure);
});
