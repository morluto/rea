import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import type { CargoManifest } from "./cargoManifest.js";
import { parseCargoManifest } from "./parseCargoManifest.js";

const artifact: CargoManifest["artifact"] = {
  path: "/fixtures/Cargo.toml",
  sha256: "a".repeat(64),
  bytes: 128,
};

const parse = (toml: string) => parseCargoManifest(parseToml(toml), artifact);

const required = <T>(result: { ok: boolean; value?: T }): T => {
  expect(result.ok).toBe(true);
  if (result.value === undefined) throw new Error("Expected a parsed manifest");
  return result.value;
};

describe("parseCargoManifest dependencies", () => {
  it("inventories a single package's dependencies without resolving them", () => {
    const value = required(
      parse(`
[package]
name = "demo"
version = "0.1.0"
edition = "2021"
rust-version = "1.74"

[dependencies]
serde = { version = "1.0", features = ["derive"], default-features = false }
anyhow = "1"
local = { path = "../local" }
tool = { git = "https://example.test/tool", tag = "v1" }
`),
    );
    expect(value.format).toBe("cargo-toml");
    expect(value.packages).toMatchObject([
      {
        name: "demo",
        version: "0.1.0",
        edition: "2021",
        rust_version: "1.74",
        is_workspace_root: false,
      },
    ]);
    const byPointer = new Map(
      value.dependencies.map((dependency) => [
        dependency.source_pointer,
        dependency,
      ]),
    );
    expect(byPointer.get("/dependencies/serde")).toMatchObject({
      name: "serde",
      requirement: "1.0",
      source: "registry",
      optional: false,
      default_features: false,
      features: ["derive"],
    });
    expect(byPointer.get("/dependencies/anyhow")).toMatchObject({
      name: "anyhow",
      requirement: "1",
      source: "registry",
      default_features: true,
    });
    expect(byPointer.get("/dependencies/local")).toMatchObject({
      source: "path",
      source_detail: "../local",
      requirement: null,
    });
    expect(byPointer.get("/dependencies/tool")).toMatchObject({
      source: "git",
      source_detail: "https://example.test/tool tag=v1",
    });
    expect(value.summary).toMatchObject({
      packages: 1,
      dependencies: 4,
      git_dependencies: 1,
      path_dependencies: 1,
      diagnostics: 0,
    });
    expect(value.source_coverage).toMatchObject({
      lockfile: "not-read",
      resolution: "not-attempted",
      build_scripts: "not-executed",
    });
  });
});

describe("parseCargoManifest workspace and target declarations", () => {
  it("keeps workspace inheritance distinct from a resolved dependency", () => {
    const value = required(
      parse(`
[workspace]
members = ["crates/*"]
resolver = "2"

[workspace.dependencies]
serde = "1.0"

[package]
name = "member"
version = "0.2.0"

[dependencies]
serde = { workspace = true, features = ["derive"] }
`),
    );
    expect(value.workspace).toEqual({
      members: ["crates/*"],
      excludes: [],
      resolver: "2",
    });
    expect(value.summary).toMatchObject({
      workspace_dependencies: 1,
      inherited_dependencies: 1,
    });
    const inherited = value.dependencies.find(
      (dependency) => dependency.source_pointer === "/dependencies/serde",
    );
    expect(inherited).toMatchObject({
      source: "workspace",
      requirement: null,
      features: ["derive"],
    });
    expect(value.diagnostics).toEqual([]);
  });

  it("retains target-specific tables", () => {
    const value = required(
      parse(`
[package]
name = "demo"
version = "0.1.0"

[target.'cfg(windows)'.dependencies]
winapi = { version = "0.3", optional = true }
`),
    );
    expect(value.summary.target_dependencies).toBe(1);
    expect(value.dependencies[0]).toMatchObject({
      name: "winapi",
      target: "cfg(windows)",
      optional: true,
      source_pointer: "/target/cfg(windows)/dependencies/winapi",
    });
  });

  it("keeps a renamed dependency's manifest key apart from its package name", () => {
    const value = required(
      parse(`
[package]
name = "demo"
version = "0.1.0"

[target.x86_64-unknown-linux-gnu.dev-dependencies]
tokio = { version = "1", package = "tokio-full" }
`),
    );
    expect(value.dependencies[0]).toMatchObject({
      name: "tokio-full",
      alias: "tokio",
      target: "x86_64-unknown-linux-gnu",
    });
  });

  it("reports an inheritance declaration that has no workspace to inherit from", () => {
    const value = required(
      parse(`
[package]
name = "demo"
version = "0.1.0"

[dependencies]
serde = { workspace = true }
`),
    );
    expect(value.diagnostics.map((entry) => entry.code)).toEqual([
      "workspace-inheritance-without-workspace",
    ]);
    expect(value.source_coverage.status).toBe("partial");
  });

  it("reports a dependency that declares no source instead of inventing one", () => {
    const value = required(
      parse(`
[package]
name = "demo"
version = "0.1.0"

[dependencies]
mystery = { optional = true }
`),
    );
    expect(value.dependencies).toEqual([]);
    expect(value.diagnostics).toMatchObject([
      { code: "invalid-dependency-declaration" },
    ]);
  });

  it("keeps feature declarations verbatim", () => {
    const value = required(
      parse(`
[package]
name = "demo"
version = "0.1.0"

[features]
default = ["std"]
std = []
full = ["std", "dep:serde"]
`),
    );
    expect(value.features).toEqual([
      {
        name: "default",
        enables: ["std"],
        source_pointer: "/features/default",
      },
      { name: "std", enables: [], source_pointer: "/features/std" },
      {
        name: "full",
        enables: ["std", "dep:serde"],
        source_pointer: "/features/full",
      },
    ]);
  });

  it("rejects a document that is neither a package nor a workspace", () => {
    expect(parse(`[profile.release]\nlto = true\n`).ok).toBe(false);
  });

  it("rejects a root value that is not a table", () => {
    expect(parseCargoManifest("not a table", artifact).ok).toBe(false);
  });
});
