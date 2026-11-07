import { describe, expect, it } from "vitest";

import { launchCommand } from "./appExport.js";
import { openSeedDocument } from "./seedDocument.js";

const HOME = "/home/ada";
const poster = ["Documents/poster.svg"];
/** The capture's home and working directory, with documents under `Documents`. */
const AT_HOME = {
  home: HOME,
  workingDirectory: HOME,
  isDocument: (path: string) => path.startsWith("Documents/"),
};

/** The reason given for a launch that opens no document, which must not be blank. */
const reasonOf = ({ opens }: ReturnType<typeof openSeedDocument>): string => {
  if (opens.kind !== "none")
    throw new Error(`the launch opens ${opens.kind}, not none`);
  expect(opens.reason.trim()).not.toBe("");
  return opens.reason;
};

describe("openSeedDocument", () => {
  it("appends the seed's one document when Exec takes files, respelled under $HOME by the launch", () => {
    const opened = openSeedDocument(["inkscape"], {
      ...AT_HOME,
      exec: "inkscape %F",
      documents: poster,
    });

    expect(opened).toEqual({
      argv: ["inkscape", `${HOME}/Documents/poster.svg`],
      opens: { kind: "seed", document: "Documents/poster.svg" },
    });
    expect(launchCommand(opened.argv, HOME, HOME)).toEqual([
      "sh",
      "-c",
      `cd "$HOME" 2>/dev/null; exec 'inkscape' "$HOME"/'Documents/poster.svg'`,
    ]);
  });

  it.each(["mousepad %U", "app %f", "env A=1 app %u", "app %U --new-window"])(
    "opens the document for Exec %j",
    (exec) => {
      expect(
        openSeedDocument(["app"], { ...AT_HOME, exec, documents: poster })
          .opens,
      ).toEqual({ kind: "seed", document: "Documents/poster.svg" });
    },
  );

  it("keeps the launch and says why when the seed holds several documents, and opens none when it holds none", () => {
    const documents = ["Documents/a.svg", "Documents/b.svg"];
    const several = openSeedDocument(["inkscape"], {
      ...AT_HOME,
      exec: "inkscape %F",
      documents,
    });

    expect(several.argv).toEqual(["inkscape"]);
    const reason = reasonOf(several);
    for (const document of documents) expect(reason).toContain(`~/${document}`);
    expect(
      openSeedDocument(["inkscape"], {
        ...AT_HOME,
        exec: "inkscape %F",
        documents: [],
      }),
    ).toEqual({
      argv: ["inkscape"],
      opens: { kind: "empty" },
    });
  });

  it("keeps the launch and says why when Exec takes no file or there is no desktop entry", () => {
    const reasons = ["xcalc", "app %i %c", null].map((exec) => {
      const opened = openSeedDocument(["app"], {
        ...AT_HOME,
        exec,
        documents: poster,
      });
      expect(opened.argv).toEqual(["app"]);
      return reasonOf(opened);
    });

    // Both Execs that take no file have the same cause.
    expect(reasons[1]).toBe(reasons[0]);
  });

  it("gives each cause of opening no document its own reason", () => {
    const reasons = [
      { exec: "app %F", documents: ["Documents/a.svg", "Documents/b.svg"] },
      { exec: "xcalc", documents: poster },
      { exec: null, documents: poster },
    ].map((facts) =>
      reasonOf(openSeedDocument(["app"], { ...AT_HOME, ...facts })),
    );

    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it("respells an argument the seed holds through a selected link", () => {
    const opened = openSeedDocument(["editor", "storage/report.md"], {
      ...AT_HOME,
      exec: "editor %f",
      documents: ["Documents/report.md"],
      isDocument: (path) => path === "Documents/report.md",
      spell: (path) =>
        path === "storage/report.md" ? "Documents/report.md" : path,
    });

    expect(opened).toEqual({
      argv: ["editor", `${HOME}/Documents/report.md`],
      opens: { kind: "captured" },
    });
    expect(
      openSeedDocument(["editor", "report.md"], {
        ...AT_HOME,
        workingDirectory: `${HOME}/storage`,
        exec: "editor %f",
        documents: ["Documents/report.md"],
        isDocument: (path) => path === "Documents/report.md",
        spell: (path) =>
          path === "storage/report.md" ? "Documents/report.md" : path,
      }),
    ).toEqual({
      argv: ["editor", `${HOME}/Documents/report.md`],
      opens: { kind: "captured" },
    });
  });

  it("leaves a command that already names a document alone, absolute or from its working directory", () => {
    for (const [argv, workingDirectory] of [
      [["typora", `${HOME}/Documents/trip.md`], HOME],
      [["typora", "Documents/trip.md"], HOME],
      [["typora", "trip.md"], `${HOME}/Documents`],
    ] as const)
      expect(
        openSeedDocument(argv, {
          ...AT_HOME,
          workingDirectory,
          exec: "typora %U",
          documents: poster,
        }),
      ).toEqual({ argv, opens: { kind: "captured" } });
  });

  it("still opens the seed's document when the command names only settings under the home", () => {
    const argv = ["geany", "--config", `${HOME}/.config/geany`];

    expect(
      openSeedDocument(argv, {
        ...AT_HOME,
        exec: "geany %F",
        documents: poster,
      }),
    ).toEqual({
      argv: [...argv, `${HOME}/Documents/poster.svg`],
      opens: { kind: "seed", document: "Documents/poster.svg" },
    });
  });
});

it("matches file URLs without changing their spelling and keeps URLs when a link is retargeted", () => {
  const url = `file://${HOME}/Documents/poster.svg`;
  expect(
    openSeedDocument(["inkscape", url], {
      ...AT_HOME,
      exec: "inkscape %U",
      documents: poster,
    }),
  ).toEqual({ argv: ["inkscape", url], opens: { kind: "captured" } });
  expect(
    openSeedDocument(
      ["inkscape", `file://${HOME}/storage/poster%20one.svg?mode=edit#page`],
      {
        ...AT_HOME,
        exec: "inkscape %U",
        documents: ["Documents/poster one.svg"],
        isDocument: (path) => path === "Documents/poster one.svg",
        spell: (path) =>
          path === "storage/poster one.svg" ? "Documents/poster one.svg" : path,
      },
    ),
  ).toEqual({
    argv: [
      "inkscape",
      `file://${HOME}/Documents/poster%20one.svg?mode=edit#page`,
    ],
    opens: { kind: "captured" },
  });
});

it("recognizes a captured relative filename containing a colon", () => {
  const argv = ["app", "Budget:2026.svg"];
  expect(
    openSeedDocument(argv, {
      ...AT_HOME,
      workingDirectory: `${HOME}/Documents`,
      exec: "app %U",
      documents: ["Documents/Budget:2026.svg"],
      isDocument: (path) => path === "Documents/Budget:2026.svg",
    }),
  ).toEqual({ argv, opens: { kind: "captured" } });
});

describe("openSeedDocument settings spelling", () => {
  it("respells a separate --config directory and an equals option", () => {
    const settings = (path: string) =>
      path === "settings/geany" ||
      path === ".config/geany" ||
      path === "settings/notes" ||
      path.startsWith("settings/notes/") ||
      path === ".config/notes" ||
      path.startsWith(".config/notes/");
    expect(
      openSeedDocument(["geany", "--config", "settings/geany"], {
        ...AT_HOME,
        exec: "geany",
        documents: [],
        isCaptured: settings,
        spell: (path) => (path === "settings/geany" ? ".config/geany" : path),
      }),
    ).toEqual({
      argv: ["geany", "--config", `${HOME}/.config/geany`],
      opens: { kind: "empty" },
    });
    expect(
      openSeedDocument(["editor", "--config=settings/notes"], {
        ...AT_HOME,
        exec: "editor",
        documents: [],
        isCaptured: settings,
        spell: (path) =>
          path === "settings/notes" || path.startsWith("settings/notes/")
            ? `.config/notes${path.slice("settings/notes".length)}`
            : path,
      }),
    ).toEqual({
      argv: ["editor", `--config=${HOME}/.config/notes`],
      opens: { kind: "empty" },
    });
  });

  it("leaves a numeric option unchanged when the working directory moves", () => {
    expect(
      openSeedDocument(["geany", "--line=10"], {
        ...AT_HOME,
        workingDirectory: `${HOME}/work`,
        launchDirectory: `${HOME}/Work`,
        exec: "geany %F",
        documents: poster,
        spell: (path) =>
          path === "work" || path.startsWith("work/")
            ? `Work${path.slice("work".length)}`
            : path,
      }),
    ).toEqual({
      argv: ["geany", "--line=10", `${HOME}/Documents/poster.svg`],
      opens: { kind: "seed", document: "Documents/poster.svg" },
    });
  });

  it("leaves a command wrapper and an encoding option unchanged when the folder moves", () => {
    expect(
      openSeedDocument(
        ["env", "GDK_BACKEND=x11", "geany", "--encoding=UTF-8", "report.md"],
        {
          ...AT_HOME,
          workingDirectory: `${HOME}/work`,
          launchDirectory: `${HOME}/.config/vendor`,
          exec: "geany %f",
          documents: [".config/vendor/report.md"],
          isDocument: (path) => path === ".config/vendor/report.md",
          spell: (path) =>
            path === "work" || path.startsWith("work/")
              ? `.config/vendor${path.slice("work".length)}`
              : path,
        },
      ),
    ).toEqual({
      argv: [
        "env",
        "GDK_BACKEND=x11",
        "geany",
        "--encoding=UTF-8",
        `${HOME}/.config/vendor/report.md`,
      ],
      opens: { kind: "captured" },
    });
  });

  it("remaps a captured path in an env assignment and leaves the program", () => {
    expect(
      openSeedDocument(["env", `GNUPGHOME=${HOME}/storage/profile`, "gpa"], {
        ...AT_HOME,
        exec: "gpa",
        documents: [],
        isCaptured: (path) => path === "storage/profile" || path === ".gnupg",
        spell: (path) => (path === "storage/profile" ? ".gnupg" : path),
      }),
    ).toEqual({
      argv: ["env", `GNUPGHOME=${HOME}/.gnupg`, "gpa"],
      opens: { kind: "empty" },
    });
  });

  it("leaves an empty env value empty when the working directory moves", () => {
    expect(
      openSeedDocument(["env", "QT_QPA_PLATFORM=", "app"], {
        ...AT_HOME,
        workingDirectory: `${HOME}/work`,
        launchDirectory: `${HOME}/.config/vendor`,
        exec: "app",
        documents: [],
        isCaptured: (path) => path === "work" || path === ".config/vendor",
        spell: (path) => (path === "work" ? ".config/vendor" : path),
      }),
    ).toEqual({
      argv: ["env", "QT_QPA_PLATFORM=", "app"],
      opens: { kind: "empty" },
    });
  });

  it("resolves a relative note in the captured directory when that directory moves", () => {
    expect(
      openSeedDocument(["editor", "note.txt"], {
        ...AT_HOME,
        workingDirectory: `${HOME}/work`,
        launchDirectory: `${HOME}/.config/vendor`,
        exec: "editor %f",
        documents: ["work/note.txt"],
        isDocument: (path) => path === "work/note.txt",
        spell: (path) => path,
      }),
    ).toEqual({
      argv: ["editor", `${HOME}/work/note.txt`],
      opens: { kind: "captured" },
    });
  });
});
