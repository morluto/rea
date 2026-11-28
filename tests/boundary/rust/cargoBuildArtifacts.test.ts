import { describe, expect, it } from "vitest";

import { cargoExecutableArtifact } from "../../../scripts/lib/cargo-build-artifacts.mjs";

const artifact = (
  name: string,
  kind: readonly string[],
  executable: string | null,
) =>
  JSON.stringify({
    reason: "compiler-artifact",
    package_id: `path+file:///fixture#${name}@0.1.0`,
    target: { name, kind, crate_types: kind },
    executable,
  });

describe("Cargo fixture executable resolution", () => {
  it("uses the target-specific path Cargo reports when CARGO_BUILD_TARGET is set", () => {
    const messages = [
      artifact("leaf", ["lib"], null),
      artifact(
        "build-script-build",
        ["custom-build"],
        "/tmp/rust-target/debug/build/app-1/build-script-build",
      ),
      JSON.stringify({ reason: "build-script-executed" }),
      artifact(
        "app",
        ["bin"],
        "/tmp/rust-target/x86_64-unknown-linux-gnu/debug/app",
      ),
      JSON.stringify({ reason: "build-finished", success: true }),
      "",
    ].join("\n");

    expect(cargoExecutableArtifact(messages, "app")).toBe(
      "/tmp/rust-target/x86_64-unknown-linux-gnu/debug/app",
    );
  });

  it("fails closed when Cargo reports no executable for the binary", () => {
    expect(() =>
      cargoExecutableArtifact(artifact("leaf", ["lib"], null), "app"),
    ).toThrow("Cargo reported no executable for binary target app.");
  });

  it("fails closed when Cargo reports conflicting executables", () => {
    const messages = [
      artifact("app", ["bin"], "/tmp/a/debug/app"),
      artifact("app", ["bin"], "/tmp/b/debug/app"),
    ].join("\n");
    expect(() => cargoExecutableArtifact(messages, "app")).toThrow(
      "multiple executables",
    );
  });
});
