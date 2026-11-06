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
      kind: "target",
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

[workspace.dependencies]
anyhow = "1.0"
log = { version = "0.4", features = ["std"] }
`;
    const res = parseCargoToml(toml);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.workspace).toBeDefined();
    const ws = res.value.workspace!;
    expect(ws.members).toEqual(["crates/core", "crates/cli"]);
    expect(ws.defaultMembers).toEqual(["crates/cli"]);
    expect(ws.exclude).toEqual(["fuzz"]);
    expect(ws.inheritedDependencies["anyhow"]?.source).toEqual({
      type: "registry",
      versionReq: "1.0",
    });
    expect(ws.inheritedDependencies["log"]?.features).toEqual(["std"]);
  });

  it("returns error on malformed TOML", () => {
    const res = parseCargoToml("this is not valid toml [[[");
    expect(res.ok).toBe(false);
  });
});

describe("parseCargoLock", () => {
  it("parses Cargo.lock v3 entries", () => {
    const lock = `
version = 3

[[package]]
name = "my-crate"
version = "0.1.0"
dependencies = [
 "serde",
 "tokio 1.35.0 (registry+https://github.com/rust-lang/crates.io-index)",
]

[[package]]
name = "serde"
version = "1.0.197"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "3fb1c873e1b9b056a4dc4c0c198b24c3efa05924387204eb4c02e8297e735d1a"
`;
    const res = parseCargoLock(lock);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.version).toBe(3);
    expect(res.value.packages).toHaveLength(2);
    expect(res.value.packages[1]).toEqual({
      name: "serde",
      version: "1.0.197",
      source: "registry+https://github.com/rust-lang/crates.io-index",
      checksum:
        "3fb1c873e1b9b056a4dc4c0c198b24c3efa05924387204eb4c02e8297e735d1a",
      dependencies: [],
    });
  });

  it("rejects unsupported lockfile versions", () => {
    const lock = `version = 99\n[[package]]\nname = "test"\nversion = "0.1.0"`;
    const res = parseCargoLock(lock);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("Unsupported Cargo.lock version: 99");
    }
  });
});

describe("inspectCargoProject and reconciliation", () => {
  it("detects missing lockfile packages and missing workspace inheritance", () => {
    const rootToml = `
[workspace]
members = ["member-a"]

[package]
name = "root-pkg"
version = "0.1.0"

[dependencies]
serde = "1.0"
missing-dep = "0.2"
inherited-dep = { workspace = true }
`;

    const lockfile = `
version = 3

[[package]]
name = "root-pkg"
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
    expect(evidence.packages).toHaveLength(1);
    expect(evidence.resolvedPackages).toHaveLength(2);

    const missingDiag = evidence.diagnostics.find(
      (d) => d.code === "missing_lockfile_package",
    );
    expect(missingDiag).toBeDefined();
    expect(missingDiag?.dependency).toBe("missing-dep");

    const unresWorkspaceDiag = evidence.diagnostics.find(
      (d) => d.code === "unresolved_workspace_dependency",
    );
    expect(unresWorkspaceDiag).toBeDefined();
    expect(unresWorkspaceDiag?.dependency).toBe("inherited-dep");
  });

  it("detects circular dependencies in feature definitions", () => {
    const rootToml = `
[package]
name = "cyclic-crate"
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
    expect(cycleDiag?.message).toContain("Feature cycle detected");
  });

  it("constructs full multi-crate workspace dependency graph", () => {
    const rootToml = `
[workspace]
members = ["crates/core", "crates/app"]

[workspace.dependencies]
shared-lib = { version = "1.0" }
`;

    const coreToml = `
[package]
name = "core"
version = "0.1.0"

[dependencies]
shared-lib = { workspace = true }
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
      (e) => e.from === "app@0.1.0" && e.to === "core",
    );
    expect(edgeAppToCore).toBeDefined();

    const edgeCoreToShared = evidence.dependencyGraph.edges.find(
      (e) => e.from === "core@0.1.0" && e.to === "shared-lib",
    );
    expect(edgeCoreToShared).toBeDefined();
  });
});

describe("compareCargoManifestEvidence", () => {
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
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "serde"
version = "1.0.190"

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
new-dep = "2.0"
`;
    const afterLock = `
version = 3

[[package]]
name = "app"
version = "0.2.0"
source = "git+https://github.com/example/app"

[[package]]
name = "serde"
version = "1.0.197"

[[package]]
name = "new-dep"
version = "2.0.0"
`;

    const before = inspectCargoProject({
      rootToml: beforeToml,
      lockfile: beforeLock,
    });
    const after = inspectCargoProject({
      rootToml: afterToml,
      lockfile: afterLock,
    });
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;

    const comparison = compareCargoManifestEvidence(before.value, after.value);
    expect(comparison.changedPackages).toHaveLength(1);
    const appChange = comparison.changedPackages[0];
    expect(appChange).toMatchObject({
      name: "app",
      beforeVersion: "0.1.0",
      afterVersion: "0.2.0",
      sourceChanged: true,
      addedDependencies: ["new-dep"],
      removedDependencies: ["old-dep"],
    });
  });
});
