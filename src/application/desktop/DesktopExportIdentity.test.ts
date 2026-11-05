import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import {
  DATABASE,
  HOME,
  SETTINGS,
  capture,
  checkpoint,
  readers,
  retained,
  writeCaptureFolder,
} from "./desktopCapture.fixture.js";

const HOSTNAME = "e81232be457d";
/** Geany's leak: its mail template took the capture user and the container's host name. */
const CONFIG = `[ui]\npref_template_mail=ada@${HOSTNAME}\npref_template_developer=ada\nlast=${HOME}/Documents/today.txt\n`;
const DB = `SQLite format 3\0rows from ${HOSTNAME}`;
const DCONF_DB = "GVariant database";
const DCONF = `[org/notes]\nmail='ada@${HOSTNAME}'\nrecent='${HOME}/x'\n`;

/** A capture whose seed names the host and user in a text file, a database and dconf keys. */
const identityCapture = (
  host: Partial<DesktopApplicationCapture["host"]> = {
    hostname: HOSTNAME,
    user: "ada",
  },
): DesktopApplicationCapture => {
  const base = capture();
  return {
    ...base,
    host: { ...base.host, ...host },
    state: {
      ...base.state,
      checkpoints: [
        checkpoint(
          "baseline",
          "baseline",
          [],
          [
            retained(SETTINGS, CONFIG),
            retained(DATABASE, DB),
            retained(`${HOME}/.config/dconf/user`, DCONF_DB),
          ],
        ),
        ...base.state.checkpoints.slice(1),
      ],
    },
  };
};

const identityReaders = {
  ...readers,
  dconf: async () => ({ ok: true as const, text: DCONF }),
};

/** Export the capture, with a task holding these checks when any are given. */
const exportIdentity = async (
  local: DesktopApplicationCapture,
  checks: readonly unknown[] = [],
) => {
  const scratch = await createTestTempDirectory("desktop-identity-");
  const task = join(scratch, "task.json");
  await writeFile(
    task,
    JSON.stringify({ name: "mail", prompt: "Set my mail.", checks }),
  );
  const directory = join(scratch, "bundle");
  const result = await exportDesktopApplication(
    {
      capture: await writeCaptureFolder(local, undefined, [
        CONFIG,
        DB,
        DCONF_DB,
      ]),
      directory,
      name: undefined,
      tasks: checks.length === 0 ? [] : [task],
    },
    identityReaders,
  );
  return { result, directory };
};

/** Every file in a bundle by its path, as text. */
const bundleFiles = async (directory: string) => {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  const files = new Map<string, string>();
  for (const entry of entries.filter((candidate) => candidate.isFile())) {
    const path = join(entry.parentPath, entry.name);
    files.set(relative(directory, path), await readFile(path, "latin1"));
  }
  return files;
};

describe("exportDesktopApplication of a capture that names its host", () => {
  it("ships no host name, user@host or captured home outside the seeds it cannot rewrite, and lists both", async () => {
    const { result, directory } = await exportIdentity(identityCapture());

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      scrubbed_files: [".config/notes/settings.ini"],
      unscrubbed_files: [".local/share/notes/notes.db"],
    });
    const files = await bundleFiles(directory);
    const seed = "envs/notes/seed/.config/notes/settings.ini";
    expect(files.get(seed)).toBe(
      "[ui]\npref_template_mail=user@localhost\npref_template_developer=ada\nlast=/home/user/Documents/today.txt\n",
    );
    const leaking = [...files]
      .filter(([, text]) =>
        [HOSTNAME, "ada@", HOME].some((spelling) => text.includes(spelling)),
      )
      .map(([path]) => path);
    expect(leaking).toEqual(["envs/notes/seed/.local/share/notes/notes.db"]);
    const module = files.get("envs/notes/notes_app.py") ?? "";
    expect(module).toContain('SEED_HOME = "/home/user"');
    expect(module).toContain("mail='user@localhost'");
    const readme = files.get("README.md") ?? "";
    expect(readme).toContain("`~/.config/notes/settings.ini`");
    expect(readme).toContain("`~/.local/share/notes/notes.db`");
  });

  it.each([
    [`pref_template_mail=ada@${HOSTNAME}`, `ada@${HOSTNAME}`],
    [HOSTNAME, HOSTNAME],
  ])("refuses a check whose value names %s", async (line, named) => {
    const { result } = await exportIdentity(identityCapture(), [
      {
        id: "mail",
        kind: "lines_absent",
        file: ".config/notes/settings.ini",
        lines: [line],
      },
    ]);

    expect(result).toMatchObject({ issues: [{ path: ["task"] }] });
    expect((result as { userMessage: string }).userMessage).toContain(named);
  });

  it("still parses and respells the home of a capture written before it recorded the host", async () => {
    const {
      hostname: _hostname,
      user: _user,
      ...older
    } = identityCapture().host;

    const { result, directory } = await exportIdentity({
      ...identityCapture(),
      host: older,
    });

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      scrubbed_files: [".config/notes/settings.ini"],
      unscrubbed_files: [],
    });
    expect(
      await readFile(
        join(directory, "envs/notes/seed/.config/notes/settings.ini"),
        "utf8",
      ),
    ).toBe(
      `[ui]\npref_template_mail=ada@${HOSTNAME}\npref_template_developer=ada\nlast=/home/user/Documents/today.txt\n`,
    );
  });
});
