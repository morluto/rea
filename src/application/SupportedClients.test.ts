import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { clientSkillDirectories, supportedClients } from "./SupportedClients.js";

const roots: string[] = [];

const temporaryHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "rea-hermes-profile-"));
  roots.push(home);
  return home;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Hermes profile paths", () => {
  it("uses the sticky profile for config and skill paths", () => {
    const home = temporaryHome();
    const hermesRoot = join(home, ".hermes");
    mkdirSync(join(hermesRoot, "profiles", "coder"), { recursive: true });
    writeFileSync(join(hermesRoot, "active_profile"), "coder\n");

    const client = supportedClients(home, "linux", {}).find(
      ({ name }) => name === "hermes",
    );

    expect(client?.configPath).toBe(
      join(hermesRoot, "profiles", "coder", "config.yaml"),
    );
    expect(
      clientSkillDirectories(home, ["hermes"], {}, "linux").map(({ directory }) => directory),
    ).toEqual([join(hermesRoot, "profiles", "coder", "skills")]);
  });

  it("does not apply the root's sticky profile twice to an explicit profile home", () => {
    const home = temporaryHome();
    const hermesRoot = join(home, ".hermes");
    const profileHome = join(hermesRoot, "profiles", "coder");
    mkdirSync(profileHome, { recursive: true });
    writeFileSync(join(hermesRoot, "active_profile"), "coder\n");

    const client = supportedClients(home, "linux", {
      HERMES_HOME: profileHome,
    }).find(({ name }) => name === "hermes");

    expect(client?.configPath).toBe(join(profileHome, "config.yaml"));
  });

  it("keeps the default home when the sticky profile is default", () => {
    const home = temporaryHome();
    const hermesRoot = join(home, ".hermes");
    mkdirSync(hermesRoot, { recursive: true });
    writeFileSync(join(hermesRoot, "active_profile"), "default\n");

    const client = supportedClients(home, "linux", {}).find(
      ({ name }) => name === "hermes",
    );

    expect(client?.configPath).toBe(join(hermesRoot, "config.yaml"));
  });
});
