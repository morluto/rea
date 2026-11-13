import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  APT_LOCATIONS,
  inspectAptRepositories,
  resolveAptLocations,
} from "./AptRepositoryInventory.js";
import { runHostQuery, type QueryRunner } from "./HostQuery.js";
import {
  GPGV_A_ONLY,
  VENDOR_A,
  VENDOR_B,
} from "../domain/desktop/aptKeys.fixture.js";

it.each(["list", "sources"] as const)(
  "does not broaden %s Signed-By fingerprint restrictions to every key in a keyring",
  async (format) => {
    const root = await createTestTempDirectory("apt-signed-by-");
    const sources = join(root, `vendor.${format}`);
    const key = join(root, "vendor.gpg");
    const trustedParts = join(root, "trusted.gpg.d");
    await mkdir(trustedParts);
    await writeFile(key, VENDOR_A.key);
    await writeFile(
      join(root, "vendor.example_repo_InRelease"),
      "controlled release",
    );
    const source = "https://vendor.example/repo stable/main amd64 Packages";
    const targets = [
      `Description: ${source}`,
      `Sourcesentry: ${sources}:1`,
      "Repo-URI: https://vendor.example/repo/",
      "Release: stable",
      "Component: main",
      "Base-URI: https://vendor.example/repo/",
      `Filename: ${join(root, "Packages")}`,
    ].join("\n");
    let verifications = 0;
    const runQuery: QueryRunner = async (command) => {
      if (command === "apt-get") return { stdout: targets, exitCode: 0 };
      if (command !== "gpgv") throw new Error(`Unexpected query ${command}`);
      verifications += 1;
      return { stdout: GPGV_A_ONLY, exitCode: 1 };
    };
    const inspect = async (signedBy: string) => {
      await writeFile(
        sources,
        format === "list"
          ? `deb [signed-by=${signedBy.replaceAll(" ", ",")}] https://vendor.example/repo stable main\n`
          : `Types: deb\nURIs: https://vendor.example/repo\nSuites: stable\nComponents: main\nSigned-By: ${signedBy}\n`,
      );
      return inspectAptRepositories(
        { sources: [source], origins: ["Vendor"] },
        {
          runQuery,
          apt: { lists: root, trustedParts, trusted: key },
        },
        undefined,
      );
    };
    const pathOnly = await inspect(key);
    expect(pathOnly.repositories[0]?.signing_key).toMatchObject({
      path: key,
      fingerprint: VENDOR_A.fingerprint,
    });
    expect(pathOnly.keys.size).toBe(1);
    for (const selector of [VENDOR_B.fingerprint, `${VENDOR_B.fingerprint}!`]) {
      for (const signedBy of [selector, `${key} ${selector}`]) {
        const restricted = await inspect(signedBy);
        expect(restricted.repositories[0]).toMatchObject({
          source,
          sources_file: sources,
          uri: "https://vendor.example/repo",
          suite: "stable",
          components: ["main"],
          signing_key: null,
          signing_key_reason: expect.stringContaining(selector),
        });
        expect(restricted.repositories[0]?.signing_key_reason).toContain(
          "not supported",
        );
        expect(restricted.keys.size).toBe(0);
      }
    }
    expect(verifications).toBe(1);
  },
);

describe.skipIf(
  process.platform !== "linux" || !existsSync("/usr/bin/apt-config"),
)("resolveAptLocations with apt-config", () => {
  it("preserves newline paths printed by the real apt-config command", async () => {
    const root = await createTestTempDirectory("apt-config-newline-");
    const selected = {
      lists: `${root}/user's\nlists/`,
      trustedParts: `${root}/trusted\nparts/`,
      trusted: `${root}/trusted\nkeys.gpg`,
    };
    const configured: QueryRunner = (command, argv, signal) =>
      runHostQuery(
        command,
        [
          "-o",
          `Dir::State::Lists=${selected.lists}`,
          "-o",
          `Dir::Etc::TrustedParts=${selected.trustedParts}`,
          "-o",
          `Dir::Etc::Trusted=${selected.trusted}`,
          ...argv,
        ],
        signal,
      );
    expect(await resolveAptLocations(configured, undefined)).toEqual(selected);
  });

  it("reads the lists folder an APT_CONFIG file names, resolved under Dir::State", async () => {
    const root = await createTestTempDirectory("apt-config-");
    const config = join(root, "apt.conf");
    await writeFile(
      config,
      `Dir::State "${root}/state";\nDir::State::Lists "user lists";\n`,
    );
    const configured: QueryRunner = (command, argv, signal) =>
      runHostQuery("env", [`APT_CONFIG=${config}`, command, ...argv], signal);

    const locations = await resolveAptLocations(configured, undefined);

    expect(locations).toEqual({
      lists: `${root}/state/user lists/`,
      trustedParts: "/etc/apt/trusted.gpg.d/",
      trusted: "/etc/apt/trusted.gpg",
    });
    expect(
      await resolveAptLocations(
        (_command, argv, signal) =>
          runHostQuery("/missing/apt-config", argv, signal),
        undefined,
      ),
    ).toEqual(APT_LOCATIONS);
  });
});
