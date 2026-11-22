import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import { exportDesktopApplication } from "./DesktopApplicationExport.js";
import {
  DATABASE,
  HOME,
  NOTE,
  SETTINGS,
  capture,
  change,
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
/** A mail setting the user changed from the captured user@host to the value the scrub writes. */
const MAIL = {
  before: `[ui]\nmail=ada@${HOSTNAME}\n`,
  after: "[ui]\nmail=user@localhost\n",
};
const NAMED = `${HOME}/.config/notes/${HOSTNAME}-notes.txt`;
/** A JSON setting keyed by the host name, which the export must not rename. */
const KEYED = `{"${HOSTNAME}": {"open": true}, "localhost": {"open": false}}`;
const EXTRA_CONTENT = [MAIL.before, MAIL.after, "clean\n", KEYED];

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

/** Export the capture, with a task holding these checks when any are given, and these dconf keys. */
const exportIdentity = async (
  local: DesktopApplicationCapture,
  checks: readonly unknown[] = [],
  dconf = DCONF,
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
        ...EXTRA_CONTENT,
      ]),
      directory,
      name: undefined,
      tasks: checks.length === 0 ? [] : [task],
    },
    { ...readers, dconf: async () => ({ ok: true as const, text: dconf }) },
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

/** The bundle files whose path or content holds the host name, `ada@` or the captured home, sorted. */
const leaking = (files: ReadonlyMap<string, string>) =>
  [...files]
    .filter(([path, text]) =>
      [HOSTNAME, "ada@", HOME].some(
        (spelling) => path.includes(spelling) || text.includes(spelling),
      ),
    )
    .map(([path]) => path)
    .sort();

describe("exportDesktopApplication of a capture that names its host", () => {
  it("ships no host name, user@host or captured home outside the seeds it cannot rewrite, and lists both", async () => {
    const { result, directory } = await exportIdentity(identityCapture());

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      scrubbed_files: ["envs/notes/seed/.config/notes/settings.ini"],
      unscrubbed_files: ["envs/notes/seed/.local/share/notes/notes.db"],
    });
    const files = await bundleFiles(directory);
    const seed = "envs/notes/seed/.config/notes/settings.ini";
    expect(files.get(seed)).toBe(
      "[ui]\npref_template_mail=user@localhost\npref_template_developer=ada\nlast=/home/user/Documents/today.txt\n",
    );
    expect(leaking(files)).toEqual([
      "envs/notes/seed/.local/share/notes/notes.db",
    ]);
    const module = files.get("envs/notes/notes_app.py") ?? "";
    expect(module).toContain('SEED_HOME = "/home/user"');
    expect(module).toContain("mail='user@localhost'");
    const readme = files.get("README.md") ?? "";
    expect(readme).toContain("`envs/notes/seed/.config/notes/settings.ini`");
    expect(readme).toContain("`envs/notes/seed/.local/share/notes/notes.db`");
  });

  it("lists every shipped file that still holds the host name, by its name, a JSON key or content, generated ones included", async () => {
    const base = identityCapture();
    const [baseline, ...later] = base.state.checkpoints;
    const named = {
      ...base,
      state: {
        ...base.state,
        checkpoints: [
          {
            ...checkpoint("baseline", "baseline", [], []),
            retained: [
              ...(baseline?.retained ?? []),
              retained(NAMED, "clean\n"),
              retained(`${HOME}/.config/notes/hosts.json`, KEYED),
            ],
          },
          ...later,
        ],
      },
    };

    const { result, directory } = await exportIdentity(
      named,
      [],
      `[org/notes]\nmail='ada@${HOSTNAME}.local'\n`,
    );

    if (result instanceof Error) throw result;
    const files = await bundleFiles(directory);
    const shipped = leaking(files);
    expect(shipped).toEqual([
      "README.md",
      "envs/notes/notes_app.py",
      `envs/notes/seed/.config/notes/${HOSTNAME}-notes.txt`,
      "envs/notes/seed/.config/notes/hosts.json",
      "envs/notes/seed/.local/share/notes/notes.db",
    ]);
    expect(files.get("envs/notes/seed/.config/notes/hosts.json")).toBe(KEYED);
    expect(result.normalized_result).toMatchObject({
      unscrubbed_files: shipped,
    });
  });

  it("checks a task's seed as the bundle ships it, so a check the scrub satisfies does not count as failing there", async () => {
    const base = capture();
    const mailCapture = {
      ...identityCapture(),
      state: {
        ...base.state,
        checkpoints: [
          checkpoint(
            "baseline",
            "baseline",
            [],
            [retained(SETTINGS, MAIL.before)],
          ),
          checkpoint(
            "edited",
            "request",
            [
              change(SETTINGS, MAIL, { state: true }),
              change(NOTE, { after: "milk\n" }),
            ],
            [retained(SETTINGS, MAIL.after), retained(NOTE, "milk\n")],
          ),
        ],
      },
    };

    const { result } = await exportIdentity(mailCapture, [
      {
        id: "mail",
        kind: "value_equals",
        file: ".config/notes/settings.ini",
        pointer: "/groups/ui/mail",
        value: "user@localhost",
      },
      {
        id: "note",
        kind: "lines_present",
        file: "Documents/today.txt",
        lines: ["milk"],
      },
    ]);

    if (result instanceof Error) throw result;
    expect(result.normalized_result).toMatchObject({
      tasks: [{ failing_on_seed: ["note"] }],
    });
  });

  it.each([
    [`pref_template_mail=ada@${HOSTNAME}`, `ada@${HOSTNAME}`],
    [HOSTNAME, HOSTNAME],
    [`url=http://${HOSTNAME}.local/`, HOSTNAME],
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
      scrubbed_files: ["envs/notes/seed/.config/notes/settings.ini"],
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

describe("exportDesktopApplication where names, syntax or an unparsed value spell the host", () => {
  it.each(["file", "kind", "check"])(
    "keeps a task on a host named %s, which only a check's field names, kind and id spell",
    async (hostname) => {
      const { result } = await exportIdentity(
        identityCapture({ hostname, user: "ada" }),
        [
          {
            kind: "lines_present",
            file: "Documents/today.txt",
            lines: ["milk"],
          },
        ],
      );

      if (result instanceof Error) throw result;
      expect(result.normalized_result).toMatchObject({
        tasks: [{ failing_on_seed: ["check-1"] }],
      });
    },
  );

  it("scrubs dconf strings by their decoded values, so a host named true keeps every key, group and literal", async () => {
    const dconf = String.raw`[org/notes/true]
wrap=true
true=uint32 1
mail='ada@true'
hosts={'true': <'true'>, 'b': <"it's true">}
blob=b'true'
`;

    const { result, directory } = await exportIdentity(
      identityCapture({ hostname: "true", user: "ada" }),
      [],
      dconf,
    );

    if (result instanceof Error) throw result;
    const module = await readFile(join(directory, "envs/notes/notes_app.py"));
    expect(module.toString("utf8")).toContain(
      `DCONF = ${JSON.stringify(`[org/notes/true]\nwrap=true\ntrue=uint32 1\nmail='user@localhost'\nhosts={'true': <'localhost'>, 'b': <"it's localhost">}\nblob=b'true'\n`)}`,
    );
  });

  it("keeps a dconf value whose string does not parse as captured, and lists the module holding it", async () => {
    const { result, directory } = await exportIdentity(
      identityCapture(),
      [],
      `[org/notes]\nmail='ada@${HOSTNAME}\nrecent='${HOME}/x'\n`,
    );

    if (result instanceof Error) throw result;
    const module = await readFile(join(directory, "envs/notes/notes_app.py"));
    expect(module.toString("utf8")).toContain(
      `DCONF = ${JSON.stringify(`[org/notes]\nmail='ada@${HOSTNAME}\nrecent='/home/user/x'\n`)}`,
    );
    expect(result.normalized_result).toMatchObject({
      unscrubbed_files: [
        "envs/notes/notes_app.py",
        "envs/notes/seed/.local/share/notes/notes.db",
      ],
    });
  });
});
