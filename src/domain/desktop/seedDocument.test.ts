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
