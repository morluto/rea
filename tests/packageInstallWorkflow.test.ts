import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { packageHopperEnvironment } from "../scripts/verify-package-environment.mjs";

describe("package installation workflows", () => {
  it("runs package E2E without the retired native rebuild script", async () => {
    const continuousIntegration = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const realHopperLinux = await readFile(
      new URL("../.github/workflows/real-hopper-linux.yml", import.meta.url),
      "utf8",
    );
    const realHopperMac = await readFile(
      new URL("../.github/workflows/real-hopper.yml", import.meta.url),
      "utf8",
    );

    expect(continuousIntegration).toContain("os: [ubuntu-latest, macos-14]");
    expect(continuousIntegration).toContain("npm run verify:package");
    expect(continuousIntegration).toContain("name: Static checks");
    expect(continuousIntegration).toContain("npm run check:ci");
    expect(continuousIntegration).toContain("shard: [1/2, 2/2]");
    expect(continuousIntegration).toContain("name: Build package");
    expect(continuousIntegration).toContain("npm run build:cached");
    expect(continuousIntegration).toContain("name: rea-dist");
    expect(continuousIntegration).toContain("npm run test:ci:shard:run");
    expect(continuousIntegration).toContain("needs: [changes, test-shard]");
    expect(continuousIntegration).toContain("if-no-files-found: error");
    expect(continuousIntegration).toContain("overwrite: true");
    expect(continuousIntegration).toContain(
      "code: ${{ steps.package.outputs.required }}",
    );
    expect(continuousIntegration).toContain("CODE_REQUIRED:");
    expect(continuousIntegration).toContain(
      'test "${CODE_REQUIRED}" != "true" || test "${SHARD_RESULT}" = "success"',
    );
    expect(continuousIntegration).toContain("npm run test:ci:merge");
    expect(continuousIntegration).toContain("needs: changes");
    expect(continuousIntegration).toContain(
      "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    );
    for (const workflow of [
      continuousIntegration,
      realHopperLinux,
      realHopperMac,
    ])
      expect(workflow).not.toContain("npm run rebuild:native");
    for (const workflow of [realHopperLinux, realHopperMac])
      expect(workflow).toContain("npm install --global --ignore-scripts");
    for (const workflow of [realHopperLinux, realHopperMac])
      expect(workflow).toContain(
        "REA_HOPPER_CONFORMANCE_MANIFEST_PATH: ${{ github.workspace }}/build/conformance/manifest.json",
      );
    expect(realHopperLinux).not.toContain("HOPPER_TARGET_PATH");
    expect(realHopperLinux).not.toContain("HOPPER_SECOND_TARGET_PATH");
    expect(realHopperLinux).not.toContain("first_target");
    expect(realHopperLinux).not.toContain("second_target");
  });

  it("verifies the package before publish and runs published canaries outside the checkout", async () => {
    const release = await readFile(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const canary = await readFile(
      new URL("../scripts/verify-published-package.mjs", import.meta.url),
      "utf8",
    );

    expect(release.indexOf("npm run verify:package")).toBeLessThan(
      release.indexOf("npm publish --access public"),
    );
    expect(release).toContain('verification_root="$(mktemp -d)"');
    expect(release).toContain('cd "${verification_root}"');
    expect(release).not.toContain('npm run verify:published -- "${version}"');
    expect(canary).toContain('mkdtemp(join(tmpdir(), "rea-published-canary-")');
    expect(canary).toContain("cwd: canaryRoot");
  });

  it("uses direct Node ownership on macOS and Windows", () => {
    const root = "/tmp/rea-package";
    const expected = {
      HOPPER_LAUNCHER_PATH: process.execPath,
      HOPPER_LOADER_ARGS_JSON: JSON.stringify([
        `${root}/tests/fixtures/fakeLauncher.mjs`,
      ]),
    };

    expect(packageHopperEnvironment(root, "darwin")).toEqual(expected);
    expect(packageHopperEnvironment(root, "win32")).toEqual(expected);
    expect(packageHopperEnvironment(root, "linux")).toEqual({
      HOPPER_LAUNCHER_PATH: "/bin/sh",
      HOPPER_LOADER_ARGS_JSON: JSON.stringify([
        "-c",
        'node_path=$1; shift; "$node_path" "$@"',
        "rea-package-hopper",
        process.execPath,
        `${root}/tests/fixtures/fakeLauncher.mjs`,
      ]),
    });
  });
});
