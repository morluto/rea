import { expect, it } from "vitest";
import {
  inspectNugetNupkgInputSchema,
  nugetNupkgEntryRole,
  nugetNupkgSchema,
} from "./nupkg.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";

const jsonSchema = (schema: {
  readonly "~standard": {
    readonly jsonSchema: {
      readonly input: (options: {
        readonly target: "draft-2020-12";
      }) => unknown;
    };
  };
}): Record<string, unknown> =>
  schema["~standard"].jsonSchema.input({
    target: "draft-2020-12",
  }) as Record<string, unknown>;

it("applies the shared absolute local-path policy to the public input", () => {
  expect(
    inspectNugetNupkgInputSchema.safeParse({ path: "pkg.nupkg" }).success,
  ).toBe(false);
  expect(inspectNugetNupkgInputSchema.safeParse({ path: "" }).success).toBe(
    false,
  );
  expect(
    inspectNugetNupkgInputSchema.safeParse({
      path: "/artifacts/pkg\0.nupkg",
    }).success,
  ).toBe(false);
  expect(
    inspectNugetNupkgInputSchema.safeParse({
      path: "/artifacts/pkg.nupkg",
    }).success,
  ).toBe(true);

  const shared = jsonSchema(absoluteLocalPathStringSchema);
  const advertised = jsonSchema(inspectNugetNupkgInputSchema);
  const path = (
    advertised.properties as Record<string, Record<string, unknown>>
  ).path;
  const {
    $schema: _schema,
    description: _sharedDescription,
    ...sharedPolicy
  } = shared;
  const { description: _pathDescription, ...pathPolicy } = path ?? {};
  expect(pathPolicy).toEqual(sharedPolicy);
  expect(path?.description).toBe(
    "Absolute filesystem path to a NuGet .nupkg package",
  );
});

it("rejects extra caller arguments and admits a package with unknown identity", () => {
  expect(
    inspectNugetNupkgInputSchema.safeParse({
      path: "/artifacts/pkg.nupkg",
      extra: true,
    }).success,
  ).toBe(false);
  const report = nugetNupkgSchema.parse({
    artifact: {
      path: "/artifacts/pkg.nupkg",
      sha256: "a".repeat(64),
      bytes: 16,
    },
    identity: null,
    license: null,
    repository: null,
    dependency_groups: [],
    contents: [],
    nuspec: null,
    coverage: { status: "complete", entries: 0, examined_nuspec_bytes: 0 },
    limitations: ["No .nuspec was selected."],
  });
  expect(report.identity).toBeNull();
  expect(report.nuspec).toBeNull();
});

it("derives NuGet folder roles from ZIP names", () => {
  expect(nugetNupkgEntryRole("lib/net8.0/Demo.dll")).toBe("lib");
  expect(nugetNupkgEntryRole("./ref/netstandard2.0/Demo.dll")).toBe("ref");
  expect(nugetNupkgEntryRole("runtimes/win-x64/native/demo.dll")).toBe(
    "runtimes",
  );
  expect(nugetNupkgEntryRole("native/demo.a")).toBe("native");
  expect(nugetNupkgEntryRole("analyzers/dotnet/cs/Demo.dll")).toBe("analyzers");
  expect(nugetNupkgEntryRole("build/Demo.targets")).toBe("build");
  expect(nugetNupkgEntryRole("buildTransitive/Demo.props")).toBe(
    "buildTransitive",
  );
  expect(nugetNupkgEntryRole("buildMultiTargeting/Demo.props")).toBe(
    "buildMultiTargeting",
  );
  expect(nugetNupkgEntryRole("content/readme.txt")).toBe("content");
  expect(nugetNupkgEntryRole("contentFiles/any/net8.0/data.json")).toBe(
    "contentFiles",
  );
  expect(nugetNupkgEntryRole("tools/net8.0/any/tool.dll")).toBe("tools");
  expect(nugetNupkgEntryRole("Demo.Package.nuspec")).toBe("nuspec");
  expect(nugetNupkgEntryRole("_rels/.rels")).toBe("opc");
  expect(nugetNupkgEntryRole("[Content_Types].xml")).toBe("opc");
  expect(nugetNupkgEntryRole("README.md")).toBe("unknown");
});
