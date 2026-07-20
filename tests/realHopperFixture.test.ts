import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadRealHopperFixtureTargets } from "../scripts/lib/real-hopper-fixture.mjs";

let root: string | undefined;
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("real Hopper fixture binding", () => {
  it("binds exact source-owned artifacts and their semantic oracle", async () => {
    const manifest = await fixtureManifest();
    await expect(loadRealHopperFixtureTargets(manifest)).resolves.toMatchObject(
      {
        primary: { path: join(root ?? "", "c") },
        secondary: { path: join(root ?? "", "version-v2") },
        large: { path: join(root ?? "", "large") },
        versionV1: { path: join(root ?? "", "version-v1") },
        versionV2: { path: join(root ?? "", "version-v2") },
        objc: { path: join(root ?? "", "objc") },
        napi: { path: join(root ?? "", "napi") },
        swift: { path: join(root ?? "", "swift") },
        largeOracle: {
          symbolPrefix: "_rea_page_",
          symbolCount: 1_205,
          stringPrefix: "REA_PAGE_",
          stringCount: 1_205,
        },
        oracle: {
          mainProcedure: "main",
          entryProcedure: "rea_entry",
          branchProcedure: "rea_branch",
          leafProcedure: "rea_leaf",
          entryString: "REA_C_ENTRY",
          leafString: "REA_C_LEAF",
          globalName: "rea_c_global",
        },
        versionV1Expectations: {
          symbols: ["_rea_version_entry", "_rea_version_leaf"],
          strings: ["REA_VERSION_ONE"],
        },
        versionV2Expectations: {
          symbols: ["_rea_version_entry", "_rea_version_leaf", "_rea_added"],
          strings: ["REA_VERSION_TWO"],
        },
        objcExpectations: {
          symbols: ["_OBJC_CLASS_$_REAWidget"],
          strings: ["REAWidget", "REAWidgetDelegate", "performAction:error:"],
        },
        napiExpectations: {
          symbols: ["_napi_register_module_v1"],
          strings: ["reaProbeOne", "reaProbeTwo", "reaProbeThree"],
        },
        swiftExpectations: {
          strings: [
            "REA_SWIFT_EXECUTE",
            "REAService",
            "REARecord",
            "REAState",
            "REAProtocol",
          ],
        },
        compilers: {
          c: {
            path: "/usr/bin/clang",
            version: "clang fixture",
            arguments: ["-O0"],
          },
        },
      },
    );
  });

  it("binds manifests that omit the optional swift fixture", async () => {
    const manifest = await fixtureManifest({ includeSwift: false });
    const targets = await loadRealHopperFixtureTargets(manifest);
    expect(targets.swift).toBeUndefined();
    expect(targets.swiftExpectations).toBeUndefined();
  });

  it("rejects digest drift and artifacts escaping the manifest root", async () => {
    const manifest = await fixtureManifest();
    await writeFile(join(root ?? "", "c"), "changed");
    await expect(loadRealHopperFixtureTargets(manifest)).rejects.toThrow(
      /digest/u,
    );

    const outside = await mkdtemp(join(tmpdir(), "rea-hopper-outside-"));
    try {
      await writeFile(join(outside, "c"), "primary");
      await rm(join(root ?? "", "c"));
      await symlink(join(outside, "c"), join(root ?? "", "c"));
      await expect(loadRealHopperFixtureTargets(manifest)).rejects.toThrow(
        /escapes/u,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects manifest entries that alias the same artifact", async () => {
    const manifest = await fixtureManifest();
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as {
      fixtures: { name: string; artifact: string; artifactSha256: string }[];
    };
    const primary = parsed.fixtures.find(({ name }) => name === "c");
    const objc = parsed.fixtures.find(({ name }) => name === "objc");
    if (primary === undefined || objc === undefined)
      throw new Error("Fixture manifest setup failed");
    objc.artifact = primary.artifact;
    objc.artifactSha256 = primary.artifactSha256;
    await writeFile(manifest, JSON.stringify(parsed));

    await expect(loadRealHopperFixtureTargets(manifest)).rejects.toThrow(
      /distinct artifacts/u,
    );
  });

  it("rejects a missing mandatory fixture", async () => {
    const manifest = await fixtureManifest();
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as {
      fixtures: { name: string }[];
    };
    parsed.fixtures = parsed.fixtures.filter(({ name }) => name !== "objc");
    await writeFile(manifest, JSON.stringify(parsed));
    await expect(loadRealHopperFixtureTargets(manifest)).rejects.toThrow(
      /Missing fixture objc/u,
    );
  });

  it("rejects malformed expectations (empty record, empty array, non-string)", async () => {
    const manifest = await fixtureManifest();
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as {
      fixtures: {
        name: string;
        expectations?: Record<string, unknown>;
      }[];
    };

    const napi = parsed.fixtures.find(({ name }) => name === "napi");
    if (napi === undefined) throw new Error("Fixture manifest setup failed");
    napi.expectations = {};
    await writeFile(manifest, JSON.stringify(parsed));
    await expect(loadRealHopperFixtureTargets(manifest)).rejects.toThrow(
      /Fixture napi expectations must be nonempty/u,
    );

    napi.expectations = { exports: [] };
    await writeFile(manifest, JSON.stringify(parsed));
    await expect(loadRealHopperFixtureTargets(manifest)).rejects.toThrow(
      /Fixture napi expectation exports must be nonempty/u,
    );

    napi.expectations = { exports: ["rea_napi_a", ""] };
    await writeFile(manifest, JSON.stringify(parsed));
    await expect(loadRealHopperFixtureTargets(manifest)).rejects.toThrow(
      /Fixture napi expectation exports must be nonempty strings/u,
    );

    napi.expectations = { exports: ["rea_napi_a", 7] };
    await writeFile(manifest, JSON.stringify(parsed));
    await expect(loadRealHopperFixtureTargets(manifest)).rejects.toThrow(
      /Fixture napi expectation exports must be nonempty strings/u,
    );
  });

  it("rejects a mandatory fixture that omits expectations", async () => {
    const manifest = await fixtureManifest();
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as {
      fixtures: {
        name: string;
        expectations?: Record<string, unknown>;
      }[];
    };
    const objc = parsed.fixtures.find(({ name }) => name === "objc");
    if (objc === undefined) throw new Error("Fixture manifest setup failed");
    delete objc.expectations;
    await writeFile(manifest, JSON.stringify(parsed));
    await expect(loadRealHopperFixtureTargets(manifest)).rejects.toThrow(
      /Fixture objc omitted its expectations/u,
    );
  });

  it("rejects missing compiler provenance", async () => {
    const manifest = await fixtureManifest();
    const parsed = JSON.parse(await readFile(manifest, "utf8")) as {
      fixtures: { name: string; compiler?: unknown }[];
    };
    const objc = parsed.fixtures.find(({ name }) => name === "objc");
    if (objc === undefined) throw new Error("Fixture manifest setup failed");
    delete objc.compiler;
    await writeFile(manifest, JSON.stringify(parsed));
    await expect(loadRealHopperFixtureTargets(manifest)).rejects.toThrow(
      /compiler provenance/u,
    );
  });
});

type FixtureSpec = {
  readonly name: string;
  readonly artifact: string;
  readonly expectations?: Record<string, unknown>;
};

const fixtureManifest = async (options?: {
  readonly includeSwift?: boolean;
}): Promise<string> => {
  root = await mkdtemp(join(tmpdir(), "rea-hopper-fixture-"));
  const buffers: Record<string, Buffer> = {
    c: Buffer.from("primary"),
    "version-v1": Buffer.from("version-v1"),
    "version-v2": Buffer.from("secondary"),
    objc: Buffer.from("objc"),
    napi: Buffer.from("napi"),
    large: Buffer.from("large"),
    swift: Buffer.from("swift"),
  };
  await Promise.all(
    Object.entries(buffers).map(([name, buffer]) =>
      writeFile(join(root ?? "", name), buffer),
    ),
  );
  const includeSwift = options?.includeSwift ?? true;
  const fixtures: FixtureSpec[] = [
    {
      name: "c",
      artifact: "c",
      expectations: {
        hopperOracle: {
          mainProcedure: "main",
          entryProcedure: "rea_entry",
          branchProcedure: "rea_branch",
          leafProcedure: "rea_leaf",
          entryString: "REA_C_ENTRY",
          leafString: "REA_C_LEAF",
          globalName: "rea_c_global",
        },
      },
    },
    {
      name: "version-v1",
      artifact: "version-v1",
      expectations: {
        symbols: ["_rea_version_entry", "_rea_version_leaf"],
        strings: ["REA_VERSION_ONE"],
      },
    },
    {
      name: "version-v2",
      artifact: "version-v2",
      expectations: {
        symbols: ["_rea_version_entry", "_rea_version_leaf", "_rea_added"],
        strings: ["REA_VERSION_TWO"],
      },
    },
    {
      name: "objc",
      artifact: "objc",
      expectations: {
        symbols: ["_OBJC_CLASS_$_REAWidget"],
        strings: ["REAWidget", "REAWidgetDelegate", "performAction:error:"],
      },
    },
    {
      name: "napi",
      artifact: "napi",
      expectations: {
        symbols: ["_napi_register_module_v1"],
        strings: ["reaProbeOne", "reaProbeTwo", "reaProbeThree"],
      },
    },
    {
      name: "large",
      artifact: "large",
      expectations: {
        symbolPrefix: "_rea_page_",
        symbolCount: 1_205,
        stringPrefix: "REA_PAGE_",
        stringCount: 1_205,
      },
    },
  ];
  if (includeSwift)
    fixtures.push({
      name: "swift",
      artifact: "swift",
      expectations: {
        strings: [
          "REA_SWIFT_EXECUTE",
          "REAService",
          "REARecord",
          "REAState",
          "REAProtocol",
        ],
      },
    });
  const manifest = join(root, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      schemaVersion: 1,
      fixtures: fixtures.map((fixture) => ({
        ...fixture,
        artifactSha256: digest(buffers[fixture.artifact] ?? Buffer.from("")),
        compiler: {
          path: "/usr/bin/clang",
          version: "clang fixture",
          arguments: ["-O0"],
        },
      })),
    }),
  );
  return manifest;
};

const digest = (value: Buffer): string =>
  createHash("sha256").update(value).digest("hex");
