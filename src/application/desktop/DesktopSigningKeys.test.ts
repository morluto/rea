import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { exportInstall } from "../../domain/desktop/appExportInstall.js";
import type {
  AptRepository,
  DesktopApplicationInventory,
} from "../../domain/desktop/desktopCapture.js";
import { DesktopContentStore } from "../../desktop/DesktopContentStore.js";
import { capture } from "./desktopCapture.fixture.js";
import { retainSigningKeys } from "./DesktopSigningKeys.js";

const KEY = Buffer.from("typora public keyring\n");
const SHA256 = createHash("sha256").update(KEY).digest("hex");

const withKey = (): DesktopApplicationInventory => {
  const { application } = capture();
  return {
    ...application,
    package: {
      ...application.package,
      apt_repositories: [
        {
          source: "https://downloads.typora.io/linux ./ Packages",
          sources_file: "/etc/apt/sources.list.d/typora.list",
          uri: "https://downloads.typora.io/linux",
          suite: "./",
          components: [],
          architectures: [],
          release: "stable",
          signing_key: {
            path: "/etc/apt/trusted.gpg.d/typora.gpg",
            sha256: SHA256,
            format: "binary",
            fingerprint: "4AC441BE68B4ADAB7439FBF9BA300B7755AFCFAE",
          },
        },
      ],
    },
  };
};

const store = async (maxBytes: number, maxFileBytes = 1024) => {
  const folder = await createTestTempDirectory("desktop-keys-");
  const content = new DesktopContentStore(folder, maxFileBytes, maxBytes);
  await content.prepare();
  return { folder, content };
};

describe("retainSigningKeys", () => {
  it("stores a verified key in the capture's content and keeps the repository as recorded", async () => {
    const { folder, content } = await store(1024);
    const inventory = withKey();

    const retained = await retainSigningKeys(
      inventory,
      new Map([[SHA256, KEY]]),
      content,
    );

    expect(retained).toBe(inventory);
    expect(await readFile(join(folder, "content", SHA256), "utf8")).toBe(
      KEY.toString(),
    );
    expect(content.files).toBe(1);
  });

  it.each([
    {
      limit: "content budget",
      maxBytes: 4,
      maxFileBytes: 1024,
      reason: "did not fit the capture's content budget",
    },
    {
      limit: "per-file limit",
      maxBytes: 1024,
      maxFileBytes: 4,
      reason: "is larger than the capture's per-file limit (--max-file-bytes)",
    },
  ])(
    "records a key over the $limit as unverified without storing it",
    async ({ maxBytes, maxFileBytes, reason }) => {
      const { content } = await store(maxBytes, maxFileBytes);

      const retained = await retainSigningKeys(
        withKey(),
        new Map([[SHA256, KEY]]),
        content,
      );

      expect(retained.package.apt_repositories?.[0]).toMatchObject({
        signing_key: null,
        signing_key_reason: `the verified key /etc/apt/trusted.gpg.d/typora.gpg ${reason}, so it was not retained`,
      });
      expect(content.files).toBe(0);
      expect(content.omissions).toEqual([]);
    },
  );
});

describe("retainSigningKeys before an export", () => {
  it("leaves out the program's package when only the repository whose key was dropped supplied it", async () => {
    const large = Buffer.alloc(64, 1);
    const small = Buffer.alloc(16, 2);
    const digest = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex");
    const signed = (
      host: string,
      bytes: Buffer,
      supplies: readonly string[],
    ): AptRepository => ({
      source: `https://${host}/linux ./ Packages`,
      sources_file: `/etc/apt/sources.list.d/${host}.list`,
      uri: `https://${host}/linux`,
      suite: "./",
      components: [],
      architectures: [],
      release: "stable",
      signing_key: {
        path: `/etc/apt/trusted.gpg.d/${host}.gpg`,
        sha256: digest(bytes),
        format: "binary",
        fingerprint: host,
      },
      supplies: [...supplies],
    });
    const { application } = capture();
    const inventory: DesktopApplicationInventory = {
      ...application,
      package: {
        kind: "deb",
        name: "typora",
        executable_package: "typora-bin",
        version: "1.14.9-1",
        architecture: "arm64",
        sources: ["https://a.example/linux ./ Packages"],
        source_origins: ["typora.io"],
        package_lists_present: true,
        apt_repositories: [
          signed("a.example", large, ["typora-bin"]),
          signed("b.example", small, []),
        ],
        library_packages: [],
      },
    };
    const { content } = await store(1024, 32);

    const retained = await retainSigningKeys(
      inventory,
      new Map([
        [digest(large), large],
        [digest(small), small],
      ]),
      content,
    );

    expect(retained.package.apt_repositories?.[0]).toMatchObject({
      signing_key: null,
      supplies: ["typora-bin"],
    });
    expect(exportInstall(retained.package, "typora", "arm64")).toMatchObject({
      ok: false,
      error: {
        reason: expect.stringContaining(
          "typora-bin, which the computer cannot install: only apt repositories the export leaves out offer it",
        ),
      },
    });
  });
});
