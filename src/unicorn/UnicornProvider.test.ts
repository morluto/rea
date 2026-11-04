import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { UnicornClient } from "./UnicornClient.js";
import { UnicornProvider } from "./UnicornProvider.js";
import {
  UNICORN_PROVIDER_IDENTITY,
  UNICORN_PYTHON_ENV_VAR,
} from "./UnicornRelease.js";

const target = (architecture: string): BinaryTarget =>
  ({ architecture }) as unknown as BinaryTarget;

const makeExecutable = async (): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> => {
  const dir = await mkdtemp(join(tmpdir(), "rea-unicorn-provider-"));
  const path = join(dir, "python");
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(path, 0o755);
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
};

describe("UnicornProvider", () => {
  it("declares the pinned identity", () => {
    const provider = new UnicornProvider({});
    expect(provider.identity()).toEqual(UNICORN_PROVIDER_IDENTITY);
    expect(provider.identity().id).toBe("unicorn");
    expect(provider.identity().version).toBe("2.1.2");
  });

  it("declares exactly the emulate_function capability", () => {
    const provider = new UnicornProvider(
      { [UNICORN_PYTHON_ENV_VAR]: "/usr/bin/python3" },
      "linux",
      "x64",
    );
    const capabilities = provider.capabilities();
    expect(capabilities.map((capability) => capability.operation)).toEqual([
      "emulate_function",
    ]);
    const capability = capabilities[0]!;
    expect(capability.available).toBe(true);
    expect(capability.effects.launchesProcess).toBe(true);
    expect(capability.effects.mutatesArtifact).toBe(false);
    expect(capability.effects.mayAccessNetwork).toBe(false);
    expect(capability.effects.mayWriteFilesystem).toBe(false);
    expect(capability.limitations.length).toBeGreaterThan(0);
  });

  it("reports unavailable capabilities without a configured Python", () => {
    const provider = new UnicornProvider({}, "linux", "x64");
    const capability = provider.capabilities()[0]!;
    expect(capability.available).toBe(false);
    expect(capability.availabilityCode).toBe("not_configured");
  });

  it("reports unavailable capabilities on an unsupported host", () => {
    const provider = new UnicornProvider(
      { [UNICORN_PYTHON_ENV_VAR]: "/usr/bin/python3" },
      "darwin",
      "arm64",
    );
    const capability = provider.capabilities()[0]!;
    expect(capability.available).toBe(false);
    expect(capability.availabilityCode).toBe("unsupported_host");
  });

  it("reports availability for an executable Python on Linux x64", async () => {
    const python = await makeExecutable();
    try {
      const provider = new UnicornProvider(
        { [UNICORN_PYTHON_ENV_VAR]: python.path },
        "linux",
        "x64",
      );
      const availability = await provider.inspectAvailability();
      expect(availability.status).toBe("available");
    } finally {
      await python.cleanup();
    }
  });

  it("reports not_configured when the variable is missing", async () => {
    const provider = new UnicornProvider({}, "linux", "x64");
    const availability = await provider.inspectAvailability();
    expect(availability.status).toBe("unavailable");
    if (availability.status === "unavailable")
      expect(availability.code).toBe("not_configured");
  });

  it("reports not_configured for a relative Python path", async () => {
    const provider = new UnicornProvider(
      { [UNICORN_PYTHON_ENV_VAR]: "relative/python" },
      "linux",
      "x64",
    );
    const availability = await provider.inspectAvailability();
    expect(availability.status).toBe("unavailable");
    if (availability.status === "unavailable")
      expect(availability.code).toBe("not_configured");
  });

  it("reports executable_missing for a nonexistent Python", async () => {
    const provider = new UnicornProvider(
      { [UNICORN_PYTHON_ENV_VAR]: "/nonexistent/python3" },
      "linux",
      "x64",
    );
    const availability = await provider.inspectAvailability();
    expect(availability.status).toBe("unavailable");
    if (availability.status === "unavailable")
      expect(availability.code).toBe("executable_missing");
  });

  it("reports unsupported_host off Linux x64", async () => {
    const provider = new UnicornProvider(
      { [UNICORN_PYTHON_ENV_VAR]: "/usr/bin/python3" },
      "win32",
      "x64",
    );
    const availability = await provider.inspectAvailability();
    expect(availability.status).toBe("unavailable");
    if (availability.status === "unavailable")
      expect(availability.code).toBe("unsupported_host");
  });

  it("supports x86_64 targets and declines other architectures", () => {
    const provider = new UnicornProvider({});
    expect(provider.inspectTargetSupport(target("x86_64")).status).toBe(
      "supported",
    );
    const declined = provider.inspectTargetSupport(target("aarch64"));
    expect(declined.status).toBe("unsupported");
    if (declined.status === "unsupported")
      expect(declined.code).toBe("architecture_unsupported");
  });

  it("resolves a profile bound to the provider identity", async () => {
    const provider = new UnicornProvider({});
    const resolution = await provider.resolveAnalysisProfile();
    expect(resolution.ok).toBe(true);
    if (resolution.ok)
      expect(resolution.value.profile?.provider.id).toBe("unicorn");
  });

  it("creates a Unicorn client and closes cleanly", async () => {
    const provider = new UnicornProvider({});
    const client = provider.createClient();
    expect(client).toBeInstanceOf(UnicornClient);
    expect((await client.close()).ok).toBe(true);
    expect((await provider.closeOwnedResources()).ok).toBe(true);
  });
});
