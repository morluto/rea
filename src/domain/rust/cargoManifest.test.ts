import { describe, expect, it } from "vitest";

import {
  compareCargoManifestEvidence,
  inspectCargoProject,
  parseCargoLock,
  parseCargoToml,
} from "./cargoManifest.js";

describe("parseCargoToml", () => {
  it("parses single package with distinct dependency types", () => {
    const toml = `
[package]
name = "my-crate"
version = "0.1.0"
edition = "2021"
description = "A demo crate"
publish = false
rust-version = "1.75"

[dependencies]
serde = "1.0.197"
tokio = { version = "1.35", features = ["full"], optional = true }
local-lib = { path = "../local-lib" }
git-dep = { git = "https://github.com/rust-lang/example", branch = "main" }
renamed = { package = "real-crate", version = "2.0" }

[dev-dependencies]
tempfile = "3.8"

[build-dependencies]
cc = "1.0"

[target.'cfg(windows)'.dependencies]
winapi = { version = "0.3", default-features = false }

[features]
default = ["std"]
std = []
async = ["tokio"]
`;
    const res = parseCargoToml(toml);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.package).toBeDefined();
    const pkg = res.value.package!;
    expect(pkg.name).toBe("my-crate");
    expect(pkg.version).toBe("0.1.0");
    expect(pkg.edition).toBe("2021");
    expect(pkg.description).toBe("A demo crate");
    expect(pkg.publish).toBe(false);
    expect(pkg.rustVersion).toBe("1.75");

    const serdeDep = pkg.dependencies.find((d) => d.name === "serde");
    expect(serdeDep).toMatchObject({
      name: "serde",
      package: "serde",
      kind: "normal",
      optional: false,
      defaultFeatures: true,
      source: { type: "registry", versionReq: "1.0.197" },
    });

    const tokioDep = pkg.dependencies.find((d) => d.name === "tokio");
    expect(tokioDep).toMatchObject({
      name: "tokio",
      package: "tokio",
      kind: "normal",
      optional: true,
      features: ["full"],
      source: { type: "registry", versionReq: "1.35" },
    });

    const pathDep = pkg.dependencies.find((d) => d.name === "local-lib");
    expect(pathDep?.source).toEqual({ type: "path", path: "../local-lib" });

    const gitDep = pkg.dependencies.find((d) => d.name === "git-dep");
    expect(gitDep?.source).toEqual({
      type: "git",
      git: "https://github.com/rust-lang/example",
      branch: "main",
    });

    const renamedDep = pkg.dependencies.find((d) => d.name === "renamed");
    expect(renamedDep?.package).toBe("real-crate");

    const devDep = pkg.dependencies.find((d) => d.name === "tempfile");
    expect(devDep?.kind).toBe("dev");

    const buildDep = pkg.dependencies.find((d) => d.name === "cc");
    expect(buildDep?.kind).toBe("build");

    const targetDep = pkg.dependencies.find((d) => d.name === "winapi");
    expect(targetDep).toMatchObject({
      kind: "normal",
      targetCondition: "cfg(windows)",
      defaultFeatures: false,
    });
  });

  it("parses workspace manifests with member and inherited dependency declarations", () => {
    const toml = `
[workspace]
members = ["crates/core", "crates/cli"]
default-members = ["crates/cli"]
exclude = ["fuzz"]

[workspace.package]
version = "1.2.3"
edition = "2021"
publish = ["internal-registry"]

[workspace.dependencies]
anyhow = "1.0"
serde = { version = "1.0", features = ["derive"] }
`;
    const res = parseCargoToml(toml);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.workspace).toBeDefined();
    const ws = res.value.workspace!;
    expect(ws.members).toEqual(["crates/core", "crates/cli"]);
    expect(ws.defaultMembers).toEqual(["crates/cli"]);
    expect(ws.exclude).toEqual(["fuzz"]);
    expect(ws.packageMetadata).toEqual({
      version: "1.2.3",
      edition: "2021",
      publish: ["internal-registry"],
    });
    expect(ws.inheritedDependencies["anyhow"]).toBeDefined();
    expect(ws.inheritedDependencies["serde"]?.features).toEqual(["derive"]);
  });

  it("returns error on malformed TOML", () => {
    const res = parseCargoToml(`[package\nname = invalid`);
    expect(res.ok).toBe(false);
  });

  it("returns error on invalid dependency shape such as numeric literal", () => {
    const toml = `
[package]
name = "bad-dep"
version = "0.1.0"

[dependencies]
foo = 123
`;
    const res = parseCargoToml(toml);
    expect(res.ok).toBe(false);
  });

  it("supports publish whitelist arrays", () => {
    const toml = `
[package]
name = "custom-publish"
version = "0.1.0"
publish = ["my-corp-registry"]
`;
    const res = parseCargoToml(toml);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.package?.publish).toEqual(["my-corp-registry"]);
  });
});

describe("parseCargoLock", () => {
  it("parses Cargo.lock v3 entries", () => {
    const lock = `
version = 3

[[package]]
name = "app"
version = "0.1.0"
dependencies = [
 "serde",
 "tokio",
]

[[package]]
name = "serde"
version = "1.0.197"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "3fb1c873e1b9b056a4dc4c0c198b24c3ffa059243875552b2fc053379b130773"

[[package]]
name = "tokio"
version = "1.35.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "c403881477b7b9dd5d71577b3dd69ac590885c6f62ca96e624ef34733330ea4f"
`;
    const res = parseCargoLock(lock);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.version).toBe(3);
    expect(res.value.packages).toHaveLength(3);
    const serde = res.value.packages.find((p) => p.name === "serde");
    expect(serde?.version).toBe("1.0.197");
    expect(serde?.source).toContain("crates.io");
    expect(serde?.checksum).toBe(
      "3fb1c873e1b9b056a4dc4c0c198b24c3ffa059243875552b2fc053379b130773",
    );
  });

  it("parses Format 1 Cargo.lock with checksums in [metadata]", () => {
    const lock = `
[[package]]
name = "legacy-crate"
version = "0.2.0"
source = "registry+https://github.com/rust-lang/crates.io-index"

[metadata]
"checksum legacy-crate 0.2.0 (registry+https://github.com/rust-lang/crates.io-index)" = "abc123checksum"
`;
    const res = parseCargoLock(lock);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.version).toBe(1);
    expect(res.value.packages[0]?.checksum).toBe("abc123checksum");
  });

  it("rejects unsupported lockfile versions", () => {
    const res = parseCargoLock(
      `version = 5\n\n[[package]]\nname = "test"\nversion = "1.0.0"`,
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toContain("Unsupported Cargo.lock version");
  });

  it("differentiates invalid lockfile syntax from unsupported versions", () => {
    const res = parseCargoLock(`[[package\nnot valid toml`);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toContain("Failed to parse Cargo.lock syntax");
  });
});

describe("inspectCargoProject and reconciliation", () => {
  it("detects missing lockfile packages and missing workspace inheritance", () => {
    const rootToml = `
[package]
name = "root"
version = "0.1.0"

[dependencies]
serde = "1.0"
missing-dep = "2.0"
shared = { workspace = true }
`;
    const lockfile = `
version = 3

[[package]]
name = "root"
version = "0.1.0"
dependencies = ["serde"]

[[package]]
name = "serde"
version = "1.0.197"
`;
    const res = inspectCargoProject({ rootToml, lockfile });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const evidence = res.value;
    const missingLock = evidence.diagnostics.find(
      (d) => d.code === "missing_lockfile_package",
    );
    expect(missingLock).toBeDefined();
    expect(missingLock?.dependency).toBe("missing-dep");

    const missingWs = evidence.diagnostics.find(
      (d) => d.code === "unresolved_workspace_dependency",
    );
    expect(missingWs).toBeDefined();
    expect(missingWs?.dependency).toBe("shared");
  });

  it("detects version mismatch when locked package version cannot satisfy requirement", () => {
    const rootToml = `
[package]
name = "root"
version = "0.1.0"

[dependencies]
foo = "=2.0.0"
`;
    const lockfile = `
version = 3

[[package]]
name = "root"
version = "0.1.0"
dependencies = ["foo"]

[[package]]
name = "foo"
version = "1.0.0"
`;
    const res = inspectCargoProject({ rootToml, lockfile });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const mismatch = res.value.diagnostics.find(
      (d) => d.code === "version_mismatch",
    );
    expect(mismatch).toBeDefined();
    expect(mismatch?.dependency).toBe("foo");
  });

  it("handles features referencing optional dependencies without false cycles", () => {
    const rootToml = `
[package]
name = "root"
version = "0.1.0"

[dependencies]
serde = { version = "1.0", optional = true }

[features]
serde = ["dep:serde", "serde/derive"]
`;
    const res = inspectCargoProject({ rootToml });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const cycles = res.value.diagnostics.filter(
      (d) => d.code === "feature_cycle",
    );
    expect(cycles).toHaveLength(0);
  });

  it("handles object prototype property names safely in feature maps", () => {
    const rootToml = `
[package]
name = "root"
version = "0.1.0"

[features]
toString = []
custom = ["toString"]
`;
    const res = inspectCargoProject({ rootToml });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const cycles = res.value.diagnostics.filter(
      (d) => d.code === "feature_cycle",
    );
    expect(cycles).toHaveLength(0);
  });

  it("detects true circular dependencies in feature definitions", () => {
    const rootToml = `
[package]
name = "cyclic"
version = "0.1.0"

[features]
feat-a = ["feat-b"]
feat-b = ["feat-c"]
feat-c = ["feat-a"]
`;
    const res = inspectCargoProject({ rootToml });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const cycleDiag = res.value.diagnostics.find(
      (d) => d.code === "feature_cycle",
    );
    expect(cycleDiag).toBeDefined();
    expect(cycleDiag?.message).toContain(
      "feat-a -> feat-b -> feat-c -> feat-a",
    );
  });
});

describe("inspectCargoProject workspace dependency graph", () => {
  it("constructs full multi-crate workspace dependency graph with matching node IDs", () => {
    const rootToml = `
[workspace]
members = ["crates/core", "crates/app"]
`;
    const coreToml = `
[package]
name = "core"
version = "0.1.0"

[dependencies]
shared-lib = "1.0"
`;
    const appToml = `
[package]
name = "app"
version = "0.1.0"

[dependencies]
core = { path = "../core" }
`;
    const lockfile = `
version = 3

[[package]]
name = "app"
version = "0.1.0"
dependencies = ["core"]

[[package]]
name = "core"
version = "0.1.0"
dependencies = ["shared-lib"]

[[package]]
name = "shared-lib"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;

    const res = inspectCargoProject({
      rootToml,
      lockfile,
      memberTomls: {
        "crates/core": coreToml,
        "crates/app": appToml,
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const evidence = res.value;
    expect(evidence.packages).toHaveLength(2);
    expect(evidence.resolvedPackages).toHaveLength(3);
    expect(evidence.diagnostics).toHaveLength(0);

    const edgeAppToCore = evidence.dependencyGraph.edges.find(
      (e) => e.from === "app@0.1.0" && e.to === "core@0.1.0",
    );
    expect(edgeAppToCore).toBeDefined();

    const edgeCoreToShared = evidence.dependencyGraph.edges.find(
      (e) =>
        e.from === "core@0.1.0" &&
        e.to ===
          "shared-lib@1.0.0(registry+https://github.com/rust-lang/crates.io-index)",
    );
    expect(edgeCoreToShared).toBeDefined();
  });

  it("applies [workspace.package] inheritance and alias workspace dependency resolution", () => {
    const rootToml = `
[workspace]
members = ["crates/member"]

[workspace.package]
version = "3.2.1"
edition = "2021"
publish = false

[workspace.dependencies]
alias = { package = "real-crate", version = "^1.0", features = ["std"] }
`;
    const memberToml = `
[package]
name = "member"
version.workspace = true
edition.workspace = true
publish.workspace = true

[dependencies]
alias = { workspace = true, features = ["extra"] }
`;
    const lockfile = `
version = 3

[[package]]
name = "member"
version = "3.2.1"
dependencies = ["real-crate"]

[[package]]
name = "real-crate"
version = "1.2.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;

    const res = inspectCargoProject({
      rootToml,
      lockfile,
      memberTomls: {
        "crates/member": memberToml,
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const pkg = res.value.packages[0]!;
    expect(pkg.version).toBe("3.2.1");
    expect(pkg.edition).toBe("2021");
    expect(pkg.publish).toBe(false);

    // Derived effective dependency has package "real-crate", features ["std", "extra"]
    const dep = pkg.dependencies[0]!;
    expect(dep.package).toBe("real-crate");
    expect(dep.features).toContain("std");
    expect(dep.features).toContain("extra");
    expect(res.value.diagnostics).toHaveLength(0);
  });
});

describe("compareCargoManifestEvidence - updates and additions", () => {
  it("identifies package additions, removals, and modifications", () => {
    const beforeToml = `
[package]
name = "app"
version = "0.1.0"

[dependencies]
serde = "1.0"
old-dep = "0.5"
`;
    const beforeLock = `
version = 3

[[package]]
name = "app"
version = "0.1.0"
dependencies = ["serde", "old-dep"]

[[package]]
name = "serde"
version = "1.0.190"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "old-dep"
version = "0.5.0"
`;
    const afterToml = `
[package]
name = "app"
version = "0.2.0"

[dependencies]
serde = "1.0"
new-dep = "1.0"
`;
    const afterLock = `
version = 3

[[package]]
name = "app"
version = "0.2.0"
dependencies = ["serde", "new-dep"]

[[package]]
name = "serde"
version = "1.0.197"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "new-dep"
version = "1.0.0"
`;

    const beforeRes = inspectCargoProject({
      rootToml: beforeToml,
      lockfile: beforeLock,
    });
    expect(beforeRes.ok).toBe(true);
    if (!beforeRes.ok) return;

    const afterRes = inspectCargoProject({
      rootToml: afterToml,
      lockfile: afterLock,
    });
    expect(afterRes.ok).toBe(true);
    if (!afterRes.ok) return;

    const comparison = compareCargoManifestEvidence(
      beforeRes.value,
      afterRes.value,
    );

    expect(comparison.changedPackages).toHaveLength(1);
    const changed = comparison.changedPackages[0]!;
    expect(changed.name).toBe("app");
    expect(changed.beforeVersion).toBe("0.1.0");
    expect(changed.afterVersion).toBe("0.2.0");
    expect(changed.addedDependencies).toContain("new-dep");
    expect(changed.removedDependencies).toContain("old-dep");

    expect(comparison.changedResolvedPackages).toBeDefined();
    const changedResolved = comparison.changedResolvedPackages!.find(
      (p) => p.name === "serde",
    );
    expect(changedResolved).toBeDefined();
    expect(changedResolved?.beforeVersion).toBe("1.0.190");
    expect(changedResolved?.afterVersion).toBe("1.0.197");
  });
});

describe("compareCargoManifestEvidence - edge cases and requirements", () => {
  it("does not report unreadable member as removed package", () => {
    const beforeEvidence = {
      packages: [
        {
          name: "unreadable-crate",
          version: "1.0.0",
          dependencies: [],
          features: {},
        },
      ],
      resolvedPackages: [],
      dependencyGraph: { nodes: [], edges: [] },
      diagnostics: [],
    };

    const afterEvidence = {
      packages: [],
      resolvedPackages: [],
      unreadableMembers: ["crates/unreadable-crate"],
      dependencyGraph: { nodes: [], edges: [] },
      diagnostics: [
        {
          code: "unresolved_workspace_dependency" as const,
          message: "Failed to parse workspace member",
          package: "crates/unreadable-crate",
        },
      ],
    };

    const comp = compareCargoManifestEvidence(beforeEvidence, afterEvidence);
    expect(comp.removedPackages).not.toContain("unreadable-crate");
  });

  it("detects dependency requirement changes even if name is unchanged", () => {
    const beforeEvidence = {
      packages: [
        {
          name: "app",
          version: "1.0.0",
          dependencies: [
            {
              name: "serde",
              package: "serde",
              kind: "normal" as const,
              optional: false,
              defaultFeatures: true,
              features: [],
              source: { type: "registry" as const, versionReq: "^1.0" },
            },
          ],
          features: {},
        },
      ],
      resolvedPackages: [],
      dependencyGraph: { nodes: [], edges: [] },
      diagnostics: [],
    };

    const afterEvidence = {
      packages: [
        {
          name: "app",
          version: "1.0.0",
          dependencies: [
            {
              name: "serde",
              package: "serde",
              kind: "normal" as const,
              optional: false,
              defaultFeatures: true,
              features: ["derive"],
              source: { type: "registry" as const, versionReq: "^2.0" },
            },
          ],
          features: {},
        },
      ],
      resolvedPackages: [],
      dependencyGraph: { nodes: [], edges: [] },
      diagnostics: [],
    };

    const comp = compareCargoManifestEvidence(beforeEvidence, afterEvidence);
    expect(comp.changedPackages).toHaveLength(1);
    expect(comp.changedPackages[0]?.changedDependencies).toContain("serde");
  });
});
