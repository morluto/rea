import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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
    for (const workflow of [
      continuousIntegration,
      realHopperLinux,
      realHopperMac,
    ])
      expect(workflow).not.toContain("npm run rebuild:native");
    for (const workflow of [realHopperLinux, realHopperMac])
      expect(workflow).toContain("npm install --global --ignore-scripts");
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
});
