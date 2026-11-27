import { expect, it } from "vitest";
import {
  inspectNugetNupkgInputSchema,
  nugetNupkgEntryRole,
  nugetNupkgSchema,
} from "./nupkg.js";

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
  expect(
    nugetNupkgEntryRole(
      "package/services/metadata/core-properties/0f07893ec48a4e929e4f9637270a574f.psmdcp",
    ),
  ).toBe("opc");
  expect(nugetNupkgEntryRole("PACKAGE\\services\\metadata\\x.psmdcp")).toBe(
    "opc",
  );
  expect(nugetNupkgEntryRole("package.txt")).toBe("unknown");
  expect(nugetNupkgEntryRole("lib/package/Demo.dll")).toBe("lib");
  expect(nugetNupkgEntryRole("README.md")).toBe("unknown");
});
