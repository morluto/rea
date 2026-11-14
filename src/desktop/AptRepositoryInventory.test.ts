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
  SIGNED_BY_BOTH,
  VENDOR_A,
  VENDOR_B,
} from "../domain/desktop/aptKeys.fixture.js";
import {
  aptListFileName,
  declaredPackageFiles,
  parseAptIndexTargets,
} from "../domain/desktop/aptRepositories.js";

describe.skipIf(
  process.platform !== "linux" || !existsSync("/usr/bin/apt-get"),
)("repository identity from real APT targets", () => {
  it.each(["list", "sources"] as const)(
    "preserves commas in %s repository fields through key retention and package attribution",
    async (format) => {
      const root = await createTestTempDirectory("apt-source-commas-");
      const sources = join(root, `vendor.${format}`);
      const key = join(root, "vendor.gpg");
      const lists = join(root, "lists");
      await mkdir(lists);
      await writeFile(key, VENDOR_A.key);
      const uris = ["https://vendor.invalid/repo,stable"];
      if (format === "sources") uris.push("https://mirror.invalid/repo");
      const declaredUris = uris.map((uri) =>
        uri.replace(
          "vendor.invalid",
          "fixture-user:fixture,password@vendor.invalid",
        ),
      );
      await writeFile(
        sources,
        format === "list"
          ? `deb [arch=amd64,arm64 signed-by=${key}] ${declaredUris[0]} stable,updates main,extra contrib\n`
          : `Types: deb\nURIs: ${declaredUris.join("/\n ")}/\nSuites: stable,updates\nComponents: main,extra contrib\nArchitectures: amd64 arm64\nSigned-By: ${key}\n`,
      );
      // No update, download or package installation: APT only describes the
      // configured targets, with source and state paths confined to this root.
      const query: QueryRunner = async (command, argv, signal) => {
        // Key verification uses the existing captured status fixture; only
        // APT's source grammar and target coordinates are exercised natively.
        if (command === "gpgv") return { stdout: GPGV_A_ONLY, exitCode: 2 };
        if (command !== "apt-get")
          throw new Error(`Unexpected query ${command}`);
        return runHostQuery(
          "/usr/bin/apt-get",
          [
            "-o",
            `Dir::Etc::sourcelist=${sources}`,
            "-o",
            "Dir::Etc::sourceparts=-",
            "-o",
            `Dir::State::lists=${lists}`,
            ...argv,
            "--no-release-info",
          ],
          signal,
        );
      };
      const output = await query(
        "apt-get",
        ["indextargets", "Created-By: Packages"],
        undefined,
      );
      if (typeof output !== "object" || output.exitCode !== 0)
        throw new Error(`APT target query failed: ${JSON.stringify(output)}`);
      const targets = parseAptIndexTargets(output.stdout);
      const selected = targets.filter(
        (target) =>
          target.component === "main,extra" &&
          target.description.endsWith(" amd64 Packages"),
      );
      expect(
        selected.map((target) => target.repoUri.replace(/\/$/u, "")),
      ).toEqual(uris);
      for (const target of selected)
        await writeFile(
          join(lists, `${aptListFileName(target.baseUri)}InRelease`),
          SIGNED_BY_BOTH,
        );
      const facts = await inspectAptRepositories(
        {
          sources: selected.map((target) => target.description),
          origins: selected.map(() => "Vendor"),
        },
        { runQuery: query, apt: { lists, trustedParts: root, trusted: key } },
        undefined,
      );
      expect(facts.repositories).toEqual(
        uris.map((uri) =>
          expect.objectContaining({
            uri,
            uri_credentials_removed: uri === uris[0],
            suite: "stable,updates",
            components: ["main,extra", "contrib"],
            architectures: ["amd64", "arm64"],
            signing_key: expect.objectContaining({
              path: key,
              fingerprint: VENDOR_A.fingerprint,
            }),
          }),
        ),
      );
      expect([...facts.keys.values()]).toEqual([VENDOR_A.key]);
      expect(JSON.stringify(facts)).not.toContain("fixture-user");
      expect(JSON.stringify(facts)).not.toContain("fixture,password");
      expect(declaredPackageFiles(facts.repositories, targets)).toEqual(
        new Set(targets.map((target) => target.description)),
      );
    },
  );
});

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
