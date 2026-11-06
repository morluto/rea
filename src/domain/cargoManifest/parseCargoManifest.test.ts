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

  it("records an inherited dependency without claiming the workspace is missing", () => {
    // A workspace member never declares its own [workspace]; the parent manifest is
    // out of scope, so inheritance is recorded rather than diagnosed as an error.
    const value = required(
      parse(`
[package]
name = "demo"
version = "0.1.0"

[dependencies]
serde = { workspace = true }
`),
    );
    expect(value.diagnostics).toEqual([]);
    expect(value.dependencies[0]).toMatchObject({
      name: "serde",
      source: "workspace",
      requirement: null,
    });
    expect(value.source_coverage.status).toBe("complete-within-scope");
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

  it("keeps a path dependency's version requirement", () => {
    const value = required(
      parse(`
[package]
name = "demo"

[dependencies]
helper = { path = "../helper", version = "1.2" }
`),
    );
    expect(value.dependencies[0]).toMatchObject({
      source: "path",
      source_detail: "../helper",
      requirement: "1.2",
    });
  });
});

describe("parseCargoManifest field validation", () => {
  it("reads the singular workspace.exclude field", () => {
    const value = required(
      parse(`
[package]
name = "demo"

[dependencies]
private = { git = "https://user:token@example.test/repo" }
`),
    );
    expect(value.dependencies[0]?.source_detail).toBe(
      "https://example.test/repo",
    );
  });

  it("reads the singular workspace.exclude field", () => {
    const value = required(
      parse(`
[workspace]
members = ["crates/*"]
exclude = ["vendor/legacy"]
`),
    );
    expect(value.workspace).toMatchObject({
      members: ["crates/*"],
      excludes: ["vendor/legacy"],
    });
  });

  it("accepts a workspace that omits members", () => {
    const value = required(
      parse(`
[package]
name = "demo"

[workspace]
`),
    );
    expect(value.workspace.members).toEqual([]);
    expect(value.diagnostics).toEqual([]);
  });

  it("reports a present but malformed dependency table", () => {
    const value = required(
      parse(`
dependencies = ["serde"]

[package]
name = "demo"
`),
    );
    expect(value.dependencies).toEqual([]);
    expect(value.diagnostics).toMatchObject([
      { code: "invalid-dependency-table", source_pointer: "/dependencies" },
    ]);
    expect(value.source_coverage.status).toBe("partial");
  });

  it("reports a malformed dependency field instead of applying a default", () => {
    const value = required(
      parse(`
[package]
name = "demo"

[dependencies]
serde = { version = "1", optional = "yes", features = 7 }
`),
    );
    expect(value.dependencies[0]).toMatchObject({
      name: "serde",
      optional: false,
      features: [],
    });
    expect(value.diagnostics.map((entry) => entry.code)).toEqual([
      "invalid-dependency-declaration",
    ]);
  });

  it("records inherited package settings instead of dropping them", () => {
    const value = required(
      parse(`
[package]
name = "demo"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
`),
    );
    expect(value.packages[0]).toMatchObject({
      version: "inherited",
      edition: "inherited",
      rust_version: "inherited",
    });
  });

  it("reads the pre-2024 dev_dependencies spelling", () => {
    const value = required(
      parse(`
[package]
name = "demo"

[dev_dependencies]
criterion = "0.5"
`),
    );
    expect(value.dependencies[0]).toMatchObject({
      name: "criterion",
      source_pointer: "/dev_dependencies/criterion",
    });
  });

  it("charges retained array contents against the fact allowance", () => {
    // 2 bytes per retained character: 170 members of 100k characters exceeds 32 MiB.
    const members = Array.from({ length: 170 }, () => "x".repeat(100_000));
    const result = parse(`
[workspace]
members = [${members.map((m) => `"${m}"`).join(", ")}]
`);
    expect(result.ok).toBe(false);
  });

  it("rejects a document that is neither a package nor a workspace", () => {
    expect(parse(`[profile.release]\nlto = true\n`).ok).toBe(false);
  });

  it("rejects a root value that is not a table", () => {
    expect(parseCargoManifest("not a table", artifact).ok).toBe(false);
  });
});
