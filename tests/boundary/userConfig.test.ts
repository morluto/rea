import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  mergeUserConfig,
  parseUserConfig,
  readUserConfig,
  userConfigFilePath,
} from "../../src/config/userConfig.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("userConfigFilePath", () => {
  it("prefers XDG_CONFIG_HOME when set to an absolute path", () => {
    const path = userConfigFilePath(
      { XDG_CONFIG_HOME: "/custom/xdg" },
      "darwin",
    );
    expect(path).toBe(join("/custom/xdg", "rea", "rea.json"));
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is relative or empty", () => {
    const home = tempHome();
    expect(
      userConfigFilePath({ HOME: home, XDG_CONFIG_HOME: "relative" }, "linux"),
    ).toBe(join(home, ".config", "rea", "rea.json"));
    expect(
      userConfigFilePath({ HOME: home, XDG_CONFIG_HOME: "" }, "linux"),
    ).toBe(join(home, ".config", "rea", "rea.json"));
  });

  it("resolves under USERPROFILE on Windows", () => {
    const home = tempHome();
    expect(userConfigFilePath({ USERPROFILE: home }, "win32")).toBe(
      join(home, ".config", "rea", "rea.json"),
    );
  });
});

describe("parseUserConfig", () => {
  it("accepts known provider settings with string values", () => {
    const parsed = parseUserConfig({
      GHIDRA_INSTALL_DIR: "/opt/ghidra",
      JAVA_HOME: "/usr/lib/jvm",
    });
    expect(parsed).toEqual({
      ok: true,
      value: { GHIDRA_INSTALL_DIR: "/opt/ghidra", JAVA_HOME: "/usr/lib/jvm" },
    });
  });

  it("rejects unknown keys so a typo'd edit fails loudly", () => {
    const parsed = parseUserConfig({ GHIDRA_INSTALLL_DIR: "/opt/ghidra" });
    expect(parsed.ok).toBe(false);
  });

  it("rejects non-string values", () => {
    const parsed = parseUserConfig({ GHIDRA_INSTALL_DIR: 42 });
    expect(parsed.ok).toBe(false);
  });

  it("rejects empty-string values so a saved empty setting cannot block startup", () => {
    const parsed = parseUserConfig({ GHIDRA_INSTALL_DIR: "" });
    expect(parsed.ok).toBe(false);
  });

  it("rejects non-object documents", () => {
    expect(parseUserConfig(["not", "an object"]).ok).toBe(false);
    expect(parseUserConfig(null).ok).toBe(false);
    expect(parseUserConfig("string").ok).toBe(false);
  });
});

describe("mergeUserConfig", () => {
  it("keeps ambient env values winning over the config file", () => {
    const merged = mergeUserConfig(
      { GHIDRA_INSTALL_DIR: "/from-env" },
      JSON.stringify({ GHIDRA_INSTALL_DIR: "/from-config" }),
    );
    expect(merged.ok && merged.value.GHIDRA_INSTALL_DIR).toBe("/from-env");
  });

  it("fills unset values from the config file", () => {
    const merged = mergeUserConfig(
      { HOME: "/home/user" },
      JSON.stringify({ GHIDRA_INSTALL_DIR: "/from-config" }),
    );
    expect(merged.ok && merged.value.GHIDRA_INSTALL_DIR).toBe("/from-config");
    expect(merged.ok && merged.value.HOME).toBe("/home/user");
  });

  it("treats a missing config as absent rather than an error", () => {
    const merged = mergeUserConfig({ HOME: "/home/user" }, undefined);
    expect(merged.ok).toBe(true);
  });

  it("reports malformed JSON as a configuration error", () => {
    const merged = mergeUserConfig({}, "{ not json");
    expect(merged.ok).toBe(false);
  });

  it("freezes the merged environment", () => {
    const merged = mergeUserConfig(
      {},
      JSON.stringify({ GHIDRA_INSTALL_DIR: "/opt/ghidra" }),
    );
    expect(Object.isFrozen(merged.ok && merged.value)).toBe(true);
  });
});

describe("readUserConfig end to end", () => {
  it("reads and merges a real file from the computed XDG path", async () => {
    const root = tempHome();
    const configDir = join(root, ".config", "rea");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "rea.json"),
      JSON.stringify({ GHIDRA_INSTALL_DIR: "/opt/ghidra" }),
      "utf8",
    );
    const contents = await readUserConfig({ HOME: root }, "darwin");
    expect(contents).toBe(
      JSON.stringify({ GHIDRA_INSTALL_DIR: "/opt/ghidra" }),
    );
  });

  it("returns undefined when no config file exists", async () => {
    const contents = await readUserConfig({ HOME: tempHome() }, "darwin");
    expect(contents).toBeUndefined();
  });
});

describe("writeUserConfig / unsetUserConfig", () => {
  it("creates the config file with sorted settings and a trailing newline", async () => {
    const { writeUserConfig } = await import("../../src/config/userConfig.js");
    const root = tempHome();
    const saved = await writeUserConfig(
      { HOME: root },
      { JAVA_HOME: "/usr/lib/jvm", GHIDRA_INSTALL_DIR: "/opt/ghidra" },
      "darwin",
    );
    expect(saved).toEqual({
      GHIDRA_INSTALL_DIR: "/opt/ghidra",
      JAVA_HOME: "/usr/lib/jvm",
    });
    const onDisk = await readFile(
      join(root, ".config", "rea", "rea.json"),
      "utf8",
    );
    expect(onDisk).toBe(
      '{\n  "GHIDRA_INSTALL_DIR": "/opt/ghidra",\n  "JAVA_HOME": "/usr/lib/jvm"\n}\n',
    );
  });

  it("merges into an existing config without dropping other keys", async () => {
    const { writeUserConfig } = await import("../../src/config/userConfig.js");
    const root = tempHome();
    await writeUserConfig(
      { HOME: root },
      { GHIDRA_INSTALL_DIR: "/opt/ghidra" },
      "darwin",
    );
    const saved = await writeUserConfig(
      { HOME: root },
      { JAVA_HOME: "/usr/lib/jvm" },
      "darwin",
    );
    expect(saved).toEqual({
      GHIDRA_INSTALL_DIR: "/opt/ghidra",
      JAVA_HOME: "/usr/lib/jvm",
    });
  });

  it("unset removes only the named keys and reports what was removed", async () => {
    const { writeUserConfig, unsetUserConfig } =
      await import("../../src/config/userConfig.js");
    const root = tempHome();
    await writeUserConfig(
      { HOME: root },
      { GHIDRA_INSTALL_DIR: "/opt/ghidra", JAVA_HOME: "/usr/lib/jvm" },
      "darwin",
    );
    const removed = await unsetUserConfig(
      { HOME: root },
      ["GHIDRA_INSTALL_DIR"],
      "darwin",
    );
    expect(removed).toEqual(["GHIDRA_INSTALL_DIR"]);
    const onDisk = JSON.parse(
      await readFile(join(root, ".config", "rea", "rea.json"), "utf8"),
    );
    expect(onDisk).toEqual({ JAVA_HOME: "/usr/lib/jvm" });
  });

  it("unset on a missing file is a no-op", async () => {
    const { unsetUserConfig } = await import("../../src/config/userConfig.js");
    const removed = await unsetUserConfig(
      { HOME: tempHome() },
      ["JAVA_HOME"],
      "darwin",
    );
    expect(removed).toEqual([]);
  });

  it("replaces the file atomically without leaving staging files behind", async () => {
    const { writeUserConfig, unsetUserConfig } =
      await import("../../src/config/userConfig.js");
    const root = tempHome();
    const configDir = join(root, ".config", "rea");
    await writeUserConfig(
      { HOME: root },
      { GHIDRA_INSTALL_DIR: "/opt/ghidra" },
      "darwin",
    );
    await unsetUserConfig({ HOME: root }, ["GHIDRA_INSTALL_DIR"], "darwin");
    const entries = await readdir(configDir);
    expect(entries).toEqual(["rea.json"]);
    expect(
      JSON.parse(await readFile(join(configDir, "rea.json"), "utf8")),
    ).toEqual({});
  });
});

describe("environmentWithUserConfig", () => {
  it("reports an unreadable config file as a configuration error, not a crash", async () => {
    const { environmentWithUserConfig } = await import("../../src/cli.js");
    const root = tempHome();
    await mkdir(join(root, ".config", "rea", "rea.json"), { recursive: true });
    const result = await environmentWithUserConfig({ HOME: root });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("rea.json");
      expect(result.error).toContain("could not be read");
    }
  });
});

function tempHome(): string {
  const path = mkdtempSync(join(tmpdir(), "rea-user-config-"));
  roots.push(path);
  return path;
}
