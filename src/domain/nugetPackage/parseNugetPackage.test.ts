import { describe, expect, it } from "vitest";
import {
  NUGET_PACKAGE_MAX_DIAGNOSTICS,
  type NugetPackageArtifact,
} from "./nugetPackage.js";
import {
  parseNugetPackage,
  type NugetArchiveMember,
} from "./parseNugetPackage.js";

const artifact: NugetPackageArtifact = {
  path: "/artifacts/Example.1.0.0.nupkg",
  sha256: "0".repeat(64),
  bytes: 1234,
};

const NUSPEC = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>Example.Package</id>
    <version>1.0.0</version>
    <authors>Example Authors</authors>
    <description>An example package.</description>
    <license type="expression">MIT</license>
    <projectUrl>https://example.test/package</projectUrl>
    <repository type="git" url="https://example.test/repo.git" branch="main" commit="abc123" />
    <dependencies>
      <group targetFramework="net8.0">
        <dependency id="Newtonsoft.Json" version="[13.0.0,14.0.0)" exclude="Build,Analyzers" />
        <dependency id="System.Text.Json" version="8.0.0" />
      </group>
      <group targetFramework="netstandard2.0">
        <dependency id="Newtonsoft.Json" version="12.0.0" />
      </group>
    </dependencies>
  </metadata>
</package>`;

const member = (
  path: string,
  extra: Partial<NugetArchiveMember> = {},
): NugetArchiveMember => ({
  path,
  bytes: 100,
  directory: false,
  encrypted: false,
  ...extra,
});

const parse = (
  members: NugetArchiveMember[],
  maxEntries = 20_000,
): ReturnType<typeof parseNugetPackage> =>
  parseNugetPackage(artifact, members, { maxEntries });

const parsed = (result: ReturnType<typeof parseNugetPackage>) => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe("parseNugetPackage: nuspec metadata", () => {
  it("inventories .nuspec identity and dependency groups as written", () => {
    const package_ = parsed(
      parse([
        member("Example.Package.nuspec", {
          bytes: NUSPEC.length,
          text: NUSPEC,
        }),
        member("lib/net8.0/Example.dll"),
        member("lib/netstandard2.0/Example.dll"),
        member("runtimes/win-x64/lib/net8.0/Example.dll"),
        member("build/Example.targets"),
      ]),
    );

    expect(package_.nuspecs).toHaveLength(1);
    const nuspec = package_.nuspecs[0];
    if (nuspec === undefined) throw new Error("Expected one nuspec");
    expect(nuspec.id).toBe("Example.Package");
    expect(nuspec.version).toBe("1.0.0");
    expect(nuspec.authors).toBe("Example Authors");
    expect(nuspec.license).toEqual({ kind: "expression", value: "MIT" });
    expect(nuspec.repository).toEqual({
      url: "https://example.test/repo.git",
      kind: "git",
      branch: "main",
      commit: "abc123",
    });
    expect(nuspec.dependency_groups).toEqual([
      {
        target_framework: "net8.0",
        dependencies: [
          {
            name: "Newtonsoft.Json",
            version_range: "[13.0.0,14.0.0)",
            exclude: "Build,Analyzers",
            include: null,
          },
          {
            name: "System.Text.Json",
            version_range: "8.0.0",
            exclude: null,
            include: null,
          },
        ],
      },
      {
        target_framework: "netstandard2.0",
        dependencies: [
          {
            name: "Newtonsoft.Json",
            version_range: "12.0.0",
            exclude: null,
            include: null,
          },
        ],
      },
    ]);

    expect(package_.summary.nuspecs).toBe(1);
    expect(package_.summary.assets).toBe(5);
    // Only lib/ framework folders are `assemblies`; a RID-specific copy under
    // runtimes/ stays a runtime asset so the two are never conflated.
    expect(package_.summary.assemblies).toBe(2);
    expect(package_.source_coverage.status).toBe("complete-within-scope");
    expect(package_.source_coverage.dependency_resolution).toBe(
      "not-performed",
    );
    expect(package_.source_coverage.network).toBe("not-contacted");
  });

  it("keeps a dependency empty attribute distinct from an absent one", () => {
    const nuspec = NUSPEC.replace(
      '<dependency id="System.Text.Json" version="8.0.0" />',
      '<dependency id="System.Text.Json" version="8.0.0" include="" exclude="" />',
    );
    const nuspecs = parsed(
      parse([
        member("Example.Package.nuspec", {
          bytes: nuspec.length,
          text: nuspec,
        }),
      ]),
    ).nuspecs;
    const group = nuspecs[0]?.dependency_groups[0];
    if (group === undefined) throw new Error("Expected one group");
    expect(group.dependencies[1]).toEqual({
      name: "System.Text.Json",
      version_range: "8.0.0",
      include: "",
      exclude: "",
    });
  });

  it("keeps an unrecognised license type unknown instead of calling it an expression", () => {
    const nuspec = NUSPEC.replace(
      '<license type="expression">MIT</license>',
      '<license type="url">https://example.test/LICENSE</license>',
    );
    const nuspecs = parsed(
      parse([
        member("Example.Package.nuspec", {
          bytes: nuspec.length,
          text: nuspec,
        }),
      ]),
    ).nuspecs;
    expect(nuspecs[0]?.license).toBeNull();
  });

  it("keeps a dependency with no id unnamed instead of inventing an empty name", () => {
    const nuspec = NUSPEC.replace(
      '<dependency id="System.Text.Json" version="8.0.0" />',
      '<dependency version="8.0.0" />',
    );
    const nuspecs = parsed(
      parse([
        member("Example.Package.nuspec", {
          bytes: nuspec.length,
          text: nuspec,
        }),
      ]),
    ).nuspecs;
    const group = nuspecs[0]?.dependency_groups[0];
    if (group === undefined) throw new Error("Expected one group");
    expect(group.dependencies[1]).toEqual({
      name: null,
      version_range: "8.0.0",
      exclude: null,
      include: null,
    });
  });
});

describe("parseNugetPackage: dependency text", () => {
  it("reads dependencies written directly under <dependencies> as the untargeted group", () => {
    const nuspec = NUSPEC.replace(
      /<dependencies>[\s\S]*<\/dependencies>/,
      '<dependencies><dependency id="Example.Flat" version="1.0.0" /></dependencies>',
    );
    const nuspecs = parsed(
      parse([
        member("Example.Package.nuspec", {
          bytes: nuspec.length,
          text: nuspec,
        }),
      ]),
    ).nuspecs;
    expect(nuspecs[0]?.dependency_groups).toEqual([
      {
        target_framework: null,
        dependencies: [
          {
            name: "Example.Flat",
            version_range: "1.0.0",
            include: null,
            exclude: null,
          },
        ],
      },
    ]);
  });
});

describe("parseNugetPackage: asset layout", () => {
  it("classifies framework and runtime folders without applying restore selection", () => {
    const package_ = parsed(
      parse([
        member("lib/net8.0/Example.dll"),
        member("lib/netstandard2.0/Example.dll"),
        member("ref/net8.0/Example.dll"),
        member("runtimes/win-x64/lib/net8.0/Example.dll"),
        member("runtimes/win-x64/native/example.so"),
        member("analyzers/dotnet/cs/Example.Analyzers.dll"),
        member("buildTransitive/Example.props"),
        member("buildMultiTargeting/Example.props"),
        member("contentFiles/any/any/readme.txt"),
        member("tools/install.ps1"),
        member("readme.md"),
      ]),
    );

    const byPath = new Map(package_.assets.map((asset) => [asset.path, asset]));
    expect(byPath.get("lib/net8.0/Example.dll")).toMatchObject({
      kind: "assemblies",
      target_framework: "net8.0",
      runtime_identifier: null,
    });
    expect(byPath.get("ref/net8.0/Example.dll")).toMatchObject({
      kind: "ref",
      target_framework: "net8.0",
    });
    const ridAssembly = byPath.get("runtimes/win-x64/lib/net8.0/Example.dll");
    expect(ridAssembly).toMatchObject({
      kind: "runtime",
      target_framework: "net8.0",
      runtime_identifier: "win-x64",
    });
    expect(byPath.get("runtimes/win-x64/native/example.so")).toMatchObject({
      kind: "runtime",
      target_framework: null,
      runtime_identifier: "win-x64",
    });
    expect(byPath.get("analyzers/dotnet/cs/Example.Analyzers.dll")?.kind).toBe(
      "analyzers",
    );
    expect(byPath.get("buildTransitive/Example.props")?.kind).toBe(
      "build-transitive",
    );
    expect(byPath.get("buildMultiTargeting/Example.props")?.kind).toBe(
      "build-multitargeting",
    );
    expect(byPath.get("contentFiles/any/any/readme.txt")?.kind).toBe(
      "content-files",
    );
    expect(byPath.get("tools/install.ps1")?.kind).toBe("tools");
    expect(byPath.get("readme.md")?.kind).toBe("other");
    // A `lib/` file with no framework folder has no framework to report.
    const bare = parsed(parse([member("lib/Example.dll")])).assets[0];
    expect(bare?.target_framework).toBe(null);
  });
});

describe("parseNugetPackage: framework folder edge cases", () => {
  it("treats an empty framework segment as no framework folder", () => {
    const byPath = new Map(
      parsed(
        parse([
          member("lib//Example.dll"),
          member("runtimes/win-x64/lib/", { directory: true }),
        ]),
      ).assets.map((asset) => [asset.path, asset]),
    );
    expect(byPath.get("lib//Example.dll")?.target_framework).toBe(null);
    expect(byPath.get("runtimes/win-x64/lib/")?.target_framework).toBe(null);
  });
});

describe("parseNugetPackage: coverage and refusals", () => {
  it("reports a package with no readable .nuspec as partial rather than empty", () => {
    const package_ = parsed(parse([member("lib/net8.0/Example.dll")]));
    expect(package_.nuspecs).toEqual([]);
    expect(package_.diagnostics.map((entry) => entry.code)).toContain(
      "no-nuspec",
    );
    expect(package_.source_coverage.status).toBe("partial");
  });

  it("keeps a malformed .nuspec as an explicit diagnostic", () => {
    const package_ = parsed(
      parse([
        member("Broken.nuspec", { text: "<package><metadata>" }),
        member("lib/net8.0/Example.dll"),
      ]),
    );
    expect(package_.nuspecs).toEqual([]);
    expect(package_.diagnostics.map((entry) => entry.code)).toContain(
      "invalid-nuspec",
    );
  });

  it("refuses a document type declaration instead of resolving it", () => {
    const package_ = parsed(
      parse([
        member("Doc.nuspec", {
          text: '<!DOCTYPE package [<!ENTITY x "y">]><package><metadata><id>Ex</id></metadata></package>',
        }),
      ]),
    );
    expect(package_.diagnostics.map((entry) => entry.code)).toContain(
      "unsupported-nuspec-doctype",
    );
  });

  it("reports every .nuspec separately when the archive carries more than one", () => {
    const second = NUSPEC.replace("1.0.0", "2.0.0");
    const package_ = parsed(
      parse([
        member("Example.nuspec", { text: NUSPEC }),
        member("lib/net8.0/Example.nuspec", { text: second }),
      ]),
    );
    expect(package_.nuspecs.map((nuspec) => nuspec.version)).toEqual([
      "1.0.0",
      "2.0.0",
    ]);
    expect(package_.diagnostics.map((entry) => entry.code)).toContain(
      "duplicate-nuspec",
    );
    // A duplicate document is an observation, not a coverage gap.
    expect(package_.source_coverage.status).toBe("complete-within-scope");
  });

  it("counts a duplicate .nuspec even when the second one cannot be parsed", () => {
    const package_ = parsed(
      parse([
        member("Example.nuspec", { text: NUSPEC }),
        member("Other.nuspec", { text: "<not-xml" }),
      ]),
    );
    expect(package_.nuspecs).toHaveLength(1);
    // Two members were encountered; rejecting the second one does not undo it.
    expect(package_.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["invalid-nuspec", "duplicate-nuspec"]),
    );
  });

  it("accepts metadata only from a package root's direct child", () => {
    const nested = `<?xml version="1.0"?><package><wrapper><metadata><id>Nested</id></metadata></wrapper></package>`;
    const unrelated = `<?xml version="1.0"?><not-package><metadata><id>Unrelated</id></metadata></not-package>`;
    for (const text of [nested, unrelated]) {
      const package_ = parsed(parse([member("Example.nuspec", { text })]));
      expect(package_.nuspecs).toEqual([]);
      expect(package_.diagnostics.map((entry) => entry.code)).toContain(
        "invalid-nuspec",
      );
      expect(package_.source_coverage.status).toBe("partial");
    }
  });

  it("keeps an explicitly empty repository attribute distinct from an omission", () => {
    const text = NUSPEC.replace(
      /<repository[^>]*\/>/u,
      '<repository url="" type="git" />',
    );
    const package_ = parsed(parse([member("Example.nuspec", { text })]));
    expect(package_.nuspecs[0]?.repository).toEqual({
      url: "",
      kind: "git",
      branch: null,
      commit: null,
    });
  });

  it("reports no runtime identifier for a file directly under runtimes", () => {
    const package_ = parsed(
      parse([
        member("runtimes/readme.txt"),
        member("runtimes/linux-x64/native/tool"),
      ]),
    );
    const byPath = new Map(package_.assets.map((asset) => [asset.path, asset]));
    expect(byPath.get("runtimes/readme.txt")?.runtime_identifier).toBeNull();
    expect(
      byPath.get("runtimes/linux-x64/native/tool")?.runtime_identifier,
    ).toBe("linux-x64");
  });

  it("reports a .nuspec past the read allowance as oversized, not malformed", () => {
    const package_ = parsed(
      parse([
        member("Huge.nuspec", { oversized: true }),
        member("lib/net8.0/Example.dll"),
      ]),
    );
    expect(package_.diagnostics.map((entry) => entry.code)).toEqual([
      "nuspec-too-large",
      "no-nuspec",
    ]);
  });

  it("refuses a member path that leaves the package root", () => {
    const package_ = parsed(
      parse([
        member("../../../etc/passwd"),
        member("/absolute/path.dll"),
        member("C:\\Windows\\system32\\evil.dll"),
        member("lib/net8.0/Example.dll"),
      ]),
    );
    expect(package_.assets.map((asset) => asset.path)).toEqual([
      "lib/net8.0/Example.dll",
    ]);
    expect(
      package_.diagnostics.filter(
        (entry) => entry.code === "unsafe-entry-path",
      ),
    ).toHaveLength(3);
    expect(package_.source_coverage.status).toBe("partial");
  });

  it("does not read an encrypted member and says so", () => {
    const package_ = parsed(
      parse([
        member("lib/net8.0/Example.dll", { encrypted: true }),
        member("Example.nuspec", { text: NUSPEC }),
      ]),
    );
    expect(package_.assets.map((asset) => asset.path)).toEqual([
      "Example.nuspec",
    ]);
    expect(package_.diagnostics.map((entry) => entry.code)).toContain(
      "encrypted-entry",
    );
  });

  it("stops at the member allowance and reports the truncation", () => {
    const package_ = parsed(
      parse(
        Array.from({ length: 5 }, (_, index) =>
          member(`lib/net8.0/${index}.dll`),
        ),
        3,
      ),
    );
    expect(package_.assets).toHaveLength(3);
    expect(package_.diagnostics.map((entry) => entry.code)).toContain(
      "entry-limit-reached",
    );
    expect(package_.source_coverage.status).toBe("partial");
  });

  it("bounds diagnostics so one hostile archive cannot grow the report", () => {
    const package_ = parsed(
      parse(
        Array.from({ length: NUGET_PACKAGE_MAX_DIAGNOSTICS + 5 }, (_, index) =>
          member(`../${index}.dll`),
        ),
      ),
    );
    expect(package_.diagnostics).toHaveLength(
      NUGET_PACKAGE_MAX_DIAGNOSTICS + 1,
    );
    expect(package_.diagnostics.at(-1)?.code).toBe("diagnostic-limit-reached");
  });

  it("gives identical packages identical identifiers", () => {
    const first = parsed(parse([member("a.dll"), member("b.dll")]));
    const second = parsed(parse([member("a.dll"), member("b.dll")]));
    expect(first.package_id).toBe(second.package_id);
    expect(first.assets.map((asset) => asset.asset_id)).toEqual(
      second.assets.map((asset) => asset.asset_id),
    );
  });
});
