import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import type { DesktopApplicationInventory } from "../../domain/desktop/desktopCapture.js";
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

const store = async (maxBytes: number) => {
  const folder = await createTestTempDirectory("desktop-keys-");
  const content = new DesktopContentStore(folder, 1024, maxBytes);
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

  it("records a key the content budget cannot hold as unverified", async () => {
    const { content } = await store(4);

    const retained = await retainSigningKeys(
      withKey(),
      new Map([[SHA256, KEY]]),
      content,
    );

    expect(retained.package.apt_repositories?.[0]).toMatchObject({
      signing_key: null,
      signing_key_reason: expect.stringContaining("content budget"),
    });
    expect(content.omissions).toEqual([]);
  });
});
