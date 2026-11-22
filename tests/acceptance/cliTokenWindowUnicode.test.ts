import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { estimateTokenCount } from "tokenx";
import { expect } from "vitest";

import { workspaceCliTest } from "../support/cli/workspaceCliFixture.js";

workspaceCliTest(
  "preserves successful TOON text across CLI token pages",
  async ({ processes, workspace }) => {
    const fileName = `${"😀é".repeat(20)}.plist`;
    const plist = workspace.path(fileName);
    const source =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ` +
      `"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
      `<plist version="1.0"><dict>` +
      `<key>Long</key><string>${"abcdefghij".repeat(300)}</string>` +
      `<key>Emoji</key><string>${"😀é".repeat(300)}</string>` +
      `</dict></plist>`;
    await writeFile(plist, source);
    const digest = createHash("sha256").update(source).digest("hex");
    const run = (
      filter: string,
      format: readonly string[],
      ...window: string[]
    ) =>
      processes.run(
        process.execPath,
        [
          resolve("scripts/rea.mjs"),
          "inspect-artifact",
          plist,
          ...format,
          "--filter-output",
          filter,
          ...window,
        ],
        {
          cwd: workspace.root,
          env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
        },
      );

    for (const [filter, format, expected, width] of [
      ["subject.identity.sha256,subject.name", [], digest, 10],
      ["subject.name", ["--format", "toon"], fileName, 7],
    ] as const) {
      const full = await run(filter, format);
      expect(full.exitCode, full.stderr).toBe(0);
      expect(full.stdout).toContain(expected);
      expect(full.stdout).toContain(fileName);
      const expectedText = full.stdout.trimEnd();
      const total = estimateTokenCount(expectedText);
      expect(total).toBeGreaterThan(width);
      let joined = "";
      for (let offset = 0; offset < total; offset += width) {
        const page = await run(
          filter,
          format,
          "--token-limit",
          String(width),
          "--token-offset",
          String(offset),
        );
        expect(page.exitCode, page.stderr).toBe(0);
        const marker = page.stdout.match(
          /\n\[truncated: showing tokens (\d+)–(\d+) of (\d+)\]\n?$/u,
        );
        if (marker === null)
          throw new Error(`Missing page marker at ${offset}`);
        expect(Number(marker[3])).toBe(total);
        expect(Number(marker[1])).toBe(offset);
        expect(Number(marker[2])).toBe(Math.min(offset + width, total));
        const body = page.stdout.slice(0, marker.index);
        expect(body.length).toBeGreaterThan(0);
        expect(body).not.toContain("\uFFFD");
        joined += body;
      }
      expect(joined).toBe(expectedText);
    }
  },
);
