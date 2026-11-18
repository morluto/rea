import { readFile } from "node:fs/promises";
import { dirname, posix } from "node:path";

import { expect } from "vitest";

import { npmInvocation } from "../../../scripts/lib/npm-invocation.mjs";
import { processTest } from "../../support/process/processFixture.js";

const NOTICE_DOCUMENTS = [
  "THIRD_PARTY_NOTICES.md",
  "licenses/README.md",
] as const;

const isLicenseLink = (target: string): boolean =>
  /(?:licenses|third_party|LICENSE|\.txt$)/iu.test(target);

const extractLocalLicenseLinks = async (
  documentPath: string,
): Promise<string[]> => {
  const content = await readFile(documentPath, "utf8");
  const directory = dirname(documentPath).replace(/\\/gu, "/");
  const links: string[] = [];
  for (const match of content.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/gu)) {
    const raw = match[1];
    if (raw === undefined || /^(?:https?:\/\/|mailto:|#)/u.test(raw)) continue;
    const target = raw.split("#")[0];
    if (target === undefined || target.length === 0) continue;
    const resolved = posix.normalize(posix.join(directory, target));
    if (isLicenseLink(resolved)) {
      links.push(resolved);
    }
  }
  return links;
};

processTest(
  "resolves packaged notice documents' local license links to shipped files",
  async ({ processes }) => {
    const invocation = npmInvocation(
      ["pack", "--dry-run", "--ignore-scripts", "--json"],
      process.env,
    );
    const result = await processes.run(
      invocation.command,
      invocation.arguments,
    );
    expect(result.exitCode, result.stderr).toBe(0);

    const [{ files }] = JSON.parse(result.stdout) as [
      { files: { path: string }[] },
    ];
    const packedFiles = new Set(files.map((file) => file.path));

    for (const document of NOTICE_DOCUMENTS) {
      expect(packedFiles.has(document), `package omitted ${document}`).toBe(
        true,
      );
      const links = await extractLocalLicenseLinks(document);
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(
          packedFiles.has(link),
          `${document} links to omitted package file: ${link}`,
        ).toBe(true);
      }
    }

    const packagedWebsiteFiles = [...packedFiles]
      .filter((file) => file.startsWith("website/"))
      .sort();
    expect(packagedWebsiteFiles).toEqual([
      "website/README.md",
      "website/public/assets/licenses/dinosaur.txt",
    ]);
    expect(packedFiles.has("website/public/assets/dino-demo.js")).toBe(false);
  },
);
