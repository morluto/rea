import { describe, expect, it } from "vitest";
import { HOPPER_DOWNLOAD_BYTES } from "./HopperDownload.js";

import {
  parseLinuxHopperReleases,
  parseMacHopperReleases,
  parseHopperReleaseJson,
} from "./HopperReleaseFeed.js";

const release = {
  version: "99.2.1",
  filename:
    "https://www.hopperapp.com:443/downloader/public/Hopper-99.2.1-Linux-demo.deb",
  file_length: "123",
  file_hash: "a".repeat(40),
  main_exe_hash: "b".repeat(64),
  signature: "AQ==",
  public: "1",
  beta: "0",
  published_at: "preserved vendor field",
};

describe("Linux Hopper release feed boundary", () => {
  it.each([
    { signature: undefined },
    { signature: "AQ==garbage" },
    { main_exe_hash: "b".repeat(40) },
    { file_length: String(HOPPER_DOWNLOAD_BYTES + 1) },
    { file_length: "0123" },
    { file_length: "NaN" },
    { public: "0" },
    { beta: "1" },
    {
      filename:
        "https://other.example/downloader/public/Hopper-99.2.1-Linux-demo.deb",
    },
    { filename: release.filename + "?token=caller" },
    { filename: release.filename + "?" },
    { filename: release.filename + "#" },
    { filename: release.filename + "#selection" },
    {
      filename: release.filename.replace("https://", "https://user:password@"),
    },
    { filename: release.filename.replace(".deb", ".rpm") },
    { filename: release.filename.replace("demo.deb", "full.deb") },
  ])(
    "rejects metadata outside the selected public package contract: %j",
    (changes) => {
      expect(
        parseLinuxHopperReleases({
          "Ubuntu / Mint": { ...release, ...changes },
        }),
      ).toMatchObject({
        ok: true,
        value: { deb: { ok: false, error: { reason: "release_metadata" } } },
      });
    },
  );

  it.each([null, [], "html error page"])(
    "keeps malformed feed roots unknown",
    (raw) => {
      expect(parseLinuxHopperReleases(raw)).toMatchObject({
        ok: false,
        error: { reason: "release_metadata" },
      });
    },
  );
});

const macRelease = {
  filename: "https://www.hopperapp.com:443/downloader/public/Hopper-demo.dmg",
  file_length: "123",
  file_hash: "a".repeat(40),
};

it("preserves complete selected release rows and keeps incomplete platforms independent", () => {
  const vendor = {
    ["__proto__"]: { observed: true },
    constructor: "vendor constructor",
    nested: [{ ["__proto__"]: "nested fact", future: null }],
  };
  const deb = {
    ...release,
    ...vendor,
    file_length: String(HOPPER_DOWNLOAD_BYTES),
  };
  const mac = {
    ...macRelease,
    ...vendor,
    file_length: `000${String(HOPPER_DOWNLOAD_BYTES)}`,
  };
  const rows = { "Ubuntu / Mint": deb, "OS X": mac, Fedora: [] };
  const linux = parseLinuxHopperReleases(rows);
  const apple = parseMacHopperReleases(rows);
  if (!linux.ok || !linux.value.deb.ok || !apple.ok)
    throw new Error("Selected releases are missing");

  // Exact serialization distinguishes owning special vendor keys from projections.
  expect(JSON.stringify(linux.value.deb.value)).toBe(JSON.stringify(deb));
  expect(JSON.stringify(apple.value)).toBe(JSON.stringify(mac));
  for (const family of ["rpm", "arch"] as const)
    expect(linux.value[family]).toMatchObject({
      ok: false,
      error: { reason: "release_metadata" },
    });
  expect(
    parseLinuxHopperReleases({
      ...rows,
      "OS X": { signature: "Sparkle DSA" },
    }),
  ).toEqual(linux);
});

it("distinguishes malformed UTF-8 from a genuine replacement character and tolerates the initial BOM", () => {
  expect(
    parseHopperReleaseJson(
      new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    ).ok,
  ).toBe(false);
  for (const bom of ["", "\uFEFF"])
    expect(
      parseHopperReleaseJson(new TextEncoder().encode(bom + '{"x":"雪�"}')),
    ).toMatchObject({ ok: true, value: { x: "雪�" } });
});

describe("macOS Hopper public download channel", () => {
  it.each([
    "https://www.hopperapp.com/downloader/public/Hopper-demo.dmg",
    "https://WWW.HOPPERAPP.COM:443/downloader/public/Hopper-demo.dmg",
    "https://www.hopperapp.com:443/downloader/public/Hopper%20demo.dmg",
  ])("preserves the admitted source spelling %s", (filename) => {
    expect(
      parseMacHopperReleases({ "OS X": { ...macRelease, filename } }),
    ).toEqual({ ok: true, value: { ...macRelease, filename } });
  });

  it.each([
    "https://www.hopperapp.com:443/downloader/public/../private/Hopper-demo.dmg",
    "https://www.hopperapp.com:443/downloader/public/%2e%2e/private/Hopper-demo.dmg",
    "https://www.hopperapp.com:443/downloader/public/Hopper-demo.dmg?",
    "https://www.hopperapp.com:443/downloader/public/Hopper-demo.dmg#",
    "https://user:password@www.hopperapp.com:443/downloader/public/Hopper-demo.dmg",
    "https://other.example/downloader/public/Hopper-demo.dmg",
    "http://www.hopperapp.com/downloader/public/Hopper-demo.dmg",
  ])("rejects a URL outside the public channel: %s", (filename) => {
    expect(
      parseMacHopperReleases({ "OS X": { ...macRelease, filename } }),
    ).toMatchObject({ ok: false, error: { reason: "release_metadata" } });
  });
});
