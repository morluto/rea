import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { withheldNotes } from "./appExportWithheld.js";

import {
  SIGN_IN_END,
  SIGN_IN_START,
  withheldFiles,
  withheldSettings,
} from "./appWithheld.js";
import type { DesktopCheckpoint } from "./desktopCapture.js";

const HOME = "/home/ada";

const checkpoint = (
  name: string,
  paths: readonly string[] = [],
): DesktopCheckpoint => ({
  name,
  trigger: name === "baseline" ? "baseline" : "request",
  at_ms: 0,
  entries: 1,
  truncated: false,
  unreadable_directories: 0,
  unchecked_paths: 0,
  unconfirmed_changes: 0,
  changes: paths.map((path) => ({
    path: `${HOME}/${path}`,
    kind: "modified",
    before: null,
    after: null,
    in_state_directory: true,
    opened_by_application: false,
  })),
  retained: [],
});

const homePath = (path: string) =>
  path.startsWith(`${HOME}/`) ? path.slice(HOME.length + 1) : null;
const OWNED = [".config/typora", "Documents"];
const CHECKPOINTS = [
  checkpoint("baseline", [".config/typora/conf.json"]),
  checkpoint(SIGN_IN_START, [".config/typora/profile.data"]),
  checkpoint("probe-1", [".config/typora/licence"]),
  checkpoint(SIGN_IN_END, [
    ".config/typora/licence",
    ".cache/typora/x",
    "/tmp",
  ]),
  checkpoint("seed", ["Documents/trip.md"]),
];

describe("withheld files", () => {
  it("withholds the owned files that changed after the sign-in's start, up to its end", () => {
    expect(
      withheldFiles(CHECKPOINTS, homePath, OWNED, {
        from: SIGN_IN_START,
        to: SIGN_IN_END,
      }),
    ).toEqual({ ok: true, value: [".config/typora/licence"] });
  });

  it("adds the files the agent names, under the owned paths only", () => {
    expect(
      withheldFiles(CHECKPOINTS, homePath, OWNED, {
        paths: ["~/.config/typora/profile.data", ".config/typora/licence"],
      }),
    ).toEqual({
      ok: true,
      value: [".config/typora/licence", ".config/typora/profile.data"],
    });
    expect(
      withheldFiles(CHECKPOINTS, homePath, OWNED, { paths: [".bashrc"] }),
    ).toMatchObject({ ok: false, error: expect.stringContaining(".bashrc") });
  });

  it("refuses a window whose checkpoints are missing or out of order", () => {
    expect(
      withheldFiles(CHECKPOINTS, homePath, OWNED, { from: SIGN_IN_START }),
    ).toMatchObject({ ok: false, error: expect.stringContaining(SIGN_IN_END) });
    expect(
      withheldFiles(CHECKPOINTS, homePath, OWNED, {
        from: SIGN_IN_END,
        to: SIGN_IN_START,
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("before") });
    expect(withheldFiles(CHECKPOINTS, homePath, OWNED, {})).toEqual({
      ok: true,
      value: [],
    });
  });

  it("refuses a window whose walks may have missed a file the sign-in wrote", () => {
    const window = { from: SIGN_IN_START, to: SIGN_IN_END };
    const gapped = (at: number, gap: Partial<DesktopCheckpoint>) =>
      withheldFiles(
        CHECKPOINTS.map((point, index) =>
          index === at ? { ...point, ...gap } : point,
        ),
        homePath,
        OWNED,
        window,
      );
    for (const [at, gap] of [
      [1, { truncated: true }],
      [2, { unreadable_directories: 1 }],
      [3, { unchecked_paths: 2 }],
      [3, { unconfirmed_changes: 1 }],
    ] as const)
      expect(gapped(at, gap)).toMatchObject({
        ok: false,
        error: expect.stringContaining(CHECKPOINTS[at]?.name ?? ""),
      });
    // A walk cut short after the window, or a change unconfirmed up to its start, leaves the window whole.
    expect(gapped(4, { truncated: true })).toMatchObject({ ok: true });
    expect(gapped(1, { unconfirmed_changes: 1 })).toMatchObject({ ok: true });
  });

  it("names each withheld file's setting, environment variable and handle", () => {
    expect(withheldSettings("typora", [".config/Typora/mAxvdiPNmi"])).toEqual([
      {
        file: ".config/Typora/mAxvdiPNmi",
        setting: "config_typora_maxvdipnmi",
        variable: "REA_TYPORA_CONFIG_TYPORA_MAXVDIPNMI",
        handle: "rea-typora-config-typora-maxvdipnmi",
      },
    ]);
    const long = `.local/share/${"deep/".repeat(12)}state.db`;
    const [named, other, again] = withheldSettings("an-app", [
      long,
      ".config/a-b",
      ".config/a_b",
    ]);
    expect(named?.handle.length).toBeLessThanOrEqual(63);
    expect(named?.variable).toMatch(/^REA_AN_APP_\w+_[0-9A-F]{8}$/u);
    expect(other?.setting).not.toBe(again?.setting);
    expect(other?.variable).not.toBe(again?.variable);
  });

  it("names settings Python takes as arguments, distinct whatever the files' order", () => {
    const files = [".pass", "1license", "file_1license", "class"];
    for (const order of [files, [...files].reverse()]) {
      const settings = withheldSettings("an-app", order).map(
        ({ setting }) => setting,
      );
      expect(new Set(settings).size).toBe(settings.length);
      for (const setting of settings) {
        expect(setting).toMatch(/^[a-z]\w*$/u);
        expect(["pass", "class"]).not.toContain(setting);
      }
    }
  });

  it("never generates a host-control variable for a withheld file", () => {
    for (const [app, file, reserved] of [
      ["agent", ".env-command", "REA_AGENT_ENV_COMMAND"],
      ["docker", ".command", "REA_DOCKER_COMMAND"],
      ["build-computer", ".rea-archive", "REA_BUILD_COMPUTER_REA_ARCHIVE"],
    ] as const) {
      const [item] = withheldSettings(app, [file]);
      expect(item?.variable).not.toBe(reserved);
      expect(item?.variable).toMatch(
        new RegExp(`^${reserved}_[0-9A-F]{8}$`, "u"),
      );
    }
  });

  it("quotes a withheld path as one shell word without expanding its contents", async () => {
    const home = await createTestTempDirectory("withheld-shell-");
    const file = ".config/My App/$(missing)'key";
    await mkdir(dirname(join(home, file)), { recursive: true });
    await writeFile(join(home, file), "literal file bytes");
    const [item] = withheldSettings("notes", [file]);
    if (item === undefined) throw new Error("missing withheld setting");
    const notes = withheldNotes({ withheld: [item] });
    const command = notes
      .split("\n")
      .find((line) => line.includes(`export ${item.variable}=`));
    if (command === undefined) throw new Error("missing setup command");
    const result = execFileSync(
      "/bin/sh",
      [
        "-c",
        `${command.replace("base64 -w0", "cat")}\nprintf '%s' \"$${item.variable}\"`,
      ],
      {
        env: { ...process.env, HOME: home },
        encoding: "utf8",
      },
    );
    expect(result).toBe("literal file bytes");
  });
});
