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

  it("keeps the launch and says why when the seed holds several documents or none", () => {
    const several = openSeedDocument(["inkscape"], {
      ...AT_HOME,
      exec: "inkscape %F",
      documents: ["Documents/a.svg", "Documents/b.svg"],
    });
    expect(several).toEqual({
      argv: ["inkscape"],
      opens: {
        kind: "none",
        reason:
          "the seed holds 2 documents (~/Documents/a.svg, ~/Documents/b.svg) and the app opens one only when it holds exactly one",
      },
    });
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

  it("keeps the launch when Exec takes no file or there is no desktop entry", () => {
    for (const exec of ["xcalc", "app %i %c"])
      expect(
        openSeedDocument(["app"], { ...AT_HOME, exec, documents: poster }),
      ).toEqual({
        argv: ["app"],
        opens: {
          kind: "none",
          reason:
            "its desktop entry's Exec takes no file (no %f, %F, %u or %U field code)",
        },
      });
    expect(
      openSeedDocument(["app"], { ...AT_HOME, exec: null, documents: poster })
        .opens,
    ).toMatchObject({
      kind: "none",
      reason: expect.stringContaining("without a desktop entry"),
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
