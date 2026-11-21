import {
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyUserConfigurationDefaults,
  parseUserConfig,
} from "../../src/config/userConfig.js";
import { userConfigFilePath } from "../../src/application/UserConfigurationLocation.js";
import {
  loadUserConfiguration,
  loadUserConfigurationDefaults,
  updateUserConfig,
} from "../../src/application/UserConfigurationStore.js";

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
    expect(path).toBe("/custom/xdg/rea/rea.json");
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is relative or empty", () => {
    const home = "/home/custom";
    expect(
      userConfigFilePath({ HOME: home, XDG_CONFIG_HOME: "relative" }, "linux"),
    ).toBe(posix.join(home, ".config", "rea", "rea.json"));
    expect(
      userConfigFilePath({ HOME: home, XDG_CONFIG_HOME: "" }, "linux"),
    ).toBe(posix.join(home, ".config", "rea", "rea.json"));
  });

  it("resolves under USERPROFILE on Windows", () => {
    const home = "C:\\Users\\custom";
    expect(userConfigFilePath({ USERPROFILE: home }, "win32")).toBe(
      win32.join(home, ".config", "rea", "rea.json"),
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

describe("applyUserConfigurationDefaults", () => {
  it("keeps explicit values and records only the defaults that filled a gap", () => {
    const environment = { HOME: "/home/user", JAVA_HOME: "/from-env" };
    const merged = applyUserConfigurationDefaults(environment, {
      GHIDRA_INSTALL_DIR: "/from-config",
      JAVA_HOME: "/from-config",
    });
    expect(merged.environment).toEqual({
      ...environment,
      GHIDRA_INSTALL_DIR: "/from-config",
    });
    expect([...merged.savedDefaults]).toEqual(["GHIDRA_INSTALL_DIR"]);
    expect(Object.isFrozen(merged.environment)).toBe(true);
  });
});

describe("loadUserConfigurationDefaults", () => {
  it("loads validated defaults from the selected config file", async () => {
    const root = tempHome();
    const path = userConfigFilePath({ HOME: root }, "darwin");
    await mkdir(join(root, ".config", "rea"), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({ GHIDRA_INSTALL_DIR: "/opt/ghidra" }),
    );
    expect(
      await loadUserConfigurationDefaults({ HOME: root }, "darwin"),
    ).toEqual({
      ok: true,
      value: { GHIDRA_INSTALL_DIR: "/opt/ghidra" },
    });
  });

  it("loads no defaults when the file is missing", async () => {
    expect(
      await loadUserConfigurationDefaults({ HOME: tempHome() }, "darwin"),
    ).toEqual({
      ok: true,
      value: {},
    });
  });

  it.skipIf(process.platform === "win32")(
    "follows a regular config symlink for startup and refuses to edit the link",
    async () => {
      const root = tempHome();
      const path = userConfigFilePath({ HOME: root }, "darwin");
      const target = join(root, "selected.json");
      const text = '{ "JAVA_HOME": "/linked" }\n';
      await mkdir(join(root, ".config", "rea"), { recursive: true });
      await writeFile(target, text);
      await symlink(target, path);
      expect(
        await loadUserConfigurationDefaults({ HOME: root }, "darwin"),
      ).toEqual({
        ok: true,
        value: { JAVA_HOME: "/linked" },
      });
      await expect(
        updateUserConfig({ HOME: root }, { JAVA_HOME: "/other" }, [], "darwin"),
      ).rejects.toThrow("regular JSON file");
      expect(await readFile(target, "utf8")).toBe(text);
      expect(await readdir(join(root, ".config", "rea"))).toEqual(["rea.json"]);
    },
  );
});

it.skipIf(process.platform === "win32")(
  "edits and backs up the config selected through native symlink and parent traversal",
  async () => {
    const home = tempHome();
    const lexical = join(home, "lexical");
    const physical = join(home, "physical");
    await mkdir(join(lexical, "rea"), { recursive: true });
    await mkdir(join(physical, "child"), { recursive: true });
    await mkdir(join(physical, "rea"), { recursive: true });
    await symlink(join(physical, "child"), join(lexical, "alias"));
    const selectedConfigHome = `${lexical}/alias/..`;
    const selected = join(physical, "rea", "rea.json");
    const decoy = join(lexical, "rea", "rea.json");
    const selectedBytes = '{ "JAVA_HOME": "/selected-java" }\n';
    const decoyBytes = '{ "JAVA_HOME": "/decoy-java" }\n';
    await writeFile(selected, selectedBytes);
    await writeFile(decoy, decoyBytes);

    const environment = { HOME: home, XDG_CONFIG_HOME: selectedConfigHome };
    expect(await loadUserConfigurationDefaults(environment)).toEqual({
      ok: true,
      value: { JAVA_HOME: "/selected-java" },
    });
    await updateUserConfig(environment, { JAVA_HOME: "/updated-java" }, []);
    expect(JSON.parse(await readFile(selected, "utf8"))).toEqual({
      JAVA_HOME: "/updated-java",
    });
    expect(await readFile(`${selected}.rea.backup`, "utf8")).toBe(
      selectedBytes,
    );
    expect(await readFile(decoy, "utf8")).toBe(decoyBytes);
    expect(await readdir(join(lexical, "rea"))).toEqual(["rea.json"]);
    expect((await readdir(join(physical, "rea"))).sort()).toEqual([
      "rea.json",
      "rea.json.rea.backup",
    ]);
  },
);

describe("updateUserConfig", () => {
  it("creates the config file with sorted settings and a trailing newline", async () => {
    const root = tempHome();
    const saved = await updateUserConfig(
      { HOME: root },
      { JAVA_HOME: "/usr/lib/jvm", GHIDRA_INSTALL_DIR: "/opt/ghidra" },
      [],
      "darwin",
    );
    expect(saved.settings).toEqual({
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
    const root = tempHome();
    await updateUserConfig(
      { HOME: root },
      { GHIDRA_INSTALL_DIR: "/opt/ghidra" },
      [],
      "darwin",
    );
    const saved = await updateUserConfig(
      { HOME: root },
      { JAVA_HOME: "/usr/lib/jvm" },
      [],
      "darwin",
    );
    expect(saved.settings).toEqual({
      GHIDRA_INSTALL_DIR: "/opt/ghidra",
      JAVA_HOME: "/usr/lib/jvm",
    });
  });

  it("unset removes only the named keys and reports what was removed", async () => {
    const root = tempHome();
    await updateUserConfig(
      { HOME: root },
      { GHIDRA_INSTALL_DIR: "/opt/ghidra", JAVA_HOME: "/usr/lib/jvm" },
      [],
      "darwin",
    );
    const { removed } = await updateUserConfig(
      { HOME: root },
      {},
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
    const { removed } = await updateUserConfig(
      { HOME: tempHome() },
      {},
      ["JAVA_HOME"],
      "darwin",
    );
    expect(removed).toEqual([]);
  });

  it("keeps the exact first snapshot and leaves no lock or staging entries", async () => {
    const root = tempHome();
    const path = userConfigFilePath({ HOME: root }, "darwin");
    const configDir = join(root, ".config", "rea");
    const original = Buffer.from(
      '{ \t"GHIDRA_INSTALL_DIR": "/opt/ghidra" }\r\n',
    );
    await mkdir(configDir, { recursive: true });
    await writeFile(path, original);
    await updateUserConfig(
      { HOME: root },
      {},
      ["GHIDRA_INSTALL_DIR"],
      "darwin",
    );
    await updateUserConfig(
      { HOME: root },
      { JAVA_HOME: "/other" },
      [],
      "darwin",
    );
    expect((await readdir(configDir)).sort()).toEqual([
      "rea.json",
      "rea.json.rea.backup",
    ]);
    expect((await readFile(`${path}.rea.backup`)).equals(original)).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      JAVA_HOME: "/other",
    });
  });
  it("rejects a native-invalid value and a second writer without changing the current file", async () => {
    const root = tempHome();
    const environment = { HOME: root };
    const path = userConfigFilePath(environment, "darwin");
    await updateUserConfig(
      environment,
      { JAVA_HOME: "/original" },
      [],
      "darwin",
    );
    const original = await readFile(path, "utf8");
    await expect(
      updateUserConfig(environment, { JAVA_HOME: "relative" }, [], "darwin"),
    ).rejects.toMatchObject({ _tag: "ConfigurationError" });
    await mkdir(`${path}.lock`);
    await expect(
      updateUserConfig(environment, { JAVA_HOME: "/other" }, [], "darwin"),
    ).rejects.toMatchObject({ _tag: "ConfigurationError" });
    expect(await readFile(path, "utf8")).toBe(original);
    await expect(readFile(`${path}.rea.backup`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("loadUserConfiguration", () => {
  it("reports an unreadable config file as a configuration error, not a crash", async () => {
    const root = tempHome();
    await mkdir(join(root, ".config", "rea", "rea.json"), { recursive: true });
    const result = await loadUserConfiguration({ HOME: root });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("rea.json");
      expect(result.error.message).toContain("could not be read");
    }
  });
});

function tempHome(): string {
  const path = mkdtempSync(join(tmpdir(), "rea-user-config-"));
  roots.push(path);
  return path;
}
