import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { PACKAGE_METADATA } from "../../generatedPackageMetadata.js";
import {
  BUILD_NODE_VERSION,
  BUILD_PACKAGE_FILE,
  buildSourceSchema,
  extraPackagesOf,
  renderBuildBundle,
  type BuildBundleFile,
  type BuildRequest,
} from "./appBuild.js";

const execute = promisify(execFile);

const request = (install: BuildRequest["install"]): BuildRequest => ({
  kind: "request",
  desktop_entry: "org.xfce.mousepad.desktop",
  install,
});
const localPayload = { kind: "file", path: "/builds/rea-prod.tar.xz" } as const;
const text = (files: readonly BuildBundleFile[], path: string): string => {
  const content = files.find((file) => file.path === path)?.content;
  if (typeof content !== "string") throw new Error(`no text file ${path}`);
  return content;
};

describe("build bundle renderer", () => {
  it("installs an archive package, opens it on demand and adds REA in a build-only layer", () => {
    const bundle = renderBuildBundle(
      request({ kind: "archive", package: "mousepad", extra_packages: [] }),
      localPayload,
    );
    expect(bundle.name).toBe("mousepad");
    expect(bundle.files.map((file) => file.path).sort()).toEqual([
      "envs/mousepad/env.toml",
      "envs/mousepad/install-rea.sh",
      "envs/mousepad/mousepad_app.py",
      "envs/mousepad/rea-payload.tar",
      "tasks/smoke.json",
    ]);
    expect(
      bundle.files.find((file) => file.path.endsWith("rea-payload.tar"))
        ?.content,
    ).toEqual({ copyFrom: "/builds/rea-prod.tar.xz" });
    const module = text(bundle.files, "envs/mousepad/mousepad_app.py");
    expect(module).toContain(
      'packages=Packages(apt=["mousepad", "libgtk-3-bin", "dconf-cli"])',
    );
    expect(module).toContain(
      `launch=Launch(at="demand", command=["sh", "-c", "cd \\"$HOME\\" 2>/dev/null; exec gtk-launch 'org.xfce.mousepad'"]),`,
    );
    expect(module).toContain('"arch": ["amd64", "arm64"]');
    expect(module).toContain(
      `Download(url="https://nodejs.org/dist/v${BUILD_NODE_VERSION}/node-v${BUILD_NODE_VERSION}-linux-x64.tar.xz", sha256="6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6", to="node-amd64.tar.xz", arch="amd64")`,
    );
    expect(module).toContain(
      'sha256="dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e", to="node-arm64.tar.xz", arch="arm64"',
    );
    expect(module).toContain('run=[RunScript(script="install-rea.sh")]');
    // Building needs no seed and no data hooks.
    expect(module).not.toMatch(/paths=|@add_data|@get_data|@reset_data/u);
    expect(text(bundle.files, "envs/mousepad/env.toml")).toContain(
      'module = "mousepad_app.py:Mousepad"',
    );
    expect(JSON.parse(text(bundle.files, "tasks/smoke.json"))).toEqual([
      { id: "env", type: "deploy_env", env_id: "mousepad" },
    ]);
    const script = text(bundle.files, "envs/mousepad/install-rea.sh");
    expect(script).toContain("/opt/rea/payload/*/scripts/rea.mjs");
    expect(script).toContain(
      `/opt/rea/node-v${BUILD_NODE_VERSION}-linux-*/bin/node`,
    );
    expect(script).toContain("exec /usr/local/bin/node /opt/rea/rea.mjs");
  });

  it("pins the Node.js release REA itself pins", () => {
    expect(BUILD_NODE_VERSION).toBe(PACKAGE_METADATA.pinnedNodeVersion);
  });
});

describe("build bundle install sources", () => {
  it("declares a vendor apt repository with its key file in the environment folder", () => {
    const key = Buffer.from(
      "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nAAAA\n-----END PGP PUBLIC KEY BLOCK-----\n",
    );
    const bundle = renderBuildBundle(
      {
        ...request({
          kind: "apt_repository",
          package: "geany",
          uri: "https://ppa.launchpadcontent.net/geany-dev/ppa/ubuntu",
          suite: "noble",
          components: ["main"],
          key_file: "/keys/geany.asc",
        }),
        desktop_entry: "geany",
        window_class: "Geany",
      },
      localPayload,
      key,
    );
    const module = text(bundle.files, "envs/geany/geany_app.py");
    expect(module).toContain(
      'sources=[AptSource(apt="https://ppa.launchpadcontent.net/geany-dev/ppa/ubuntu", suite="noble", components=["main"], key="apt-keys/geany.asc")],',
    );
    expect(module).toContain(
      'window={"class": "Geany"}, ready=Ready(window=True)',
    );
    const copied = bundle.files.find(
      (file) => file.path === "envs/geany/apt-keys/geany.asc",
    )?.content;
    expect(copied instanceof Uint8Array && key.equals(copied)).toBe(true);
  });

  it("installs an archive package's extra packages beside it", () => {
    const bundle = renderBuildBundle(
      request({
        kind: "archive",
        package: "freeplane",
        extra_packages: ["openjdk-17-jre"],
      }),
      localPayload,
    );
    expect(text(bundle.files, "envs/mousepad/mousepad_app.py")).toContain(
      'packages=Packages(apt=["freeplane", "openjdk-17-jre", "libgtk-3-bin", "dconf-cli"])',
    );
  });

  it("downloads a .deb for its architecture and installs it after its dependencies", () => {
    const sha256 = "a".repeat(64);
    const bundle = renderBuildBundle(
      request({
        kind: "package_file",
        url: "https://downloads.example.com/varicad.deb",
        sha256,
        architecture: "amd64",
        dependencies: ["libgl1"],
      }),
      {
        kind: "download",
        url: "https://releases.example.com/rea.tar.xz",
        sha256: "b".repeat(64),
      },
    );
    const module = text(bundle.files, "envs/mousepad/mousepad_app.py");
    expect(module).toContain(
      'packages=Packages(apt=["libgl1", "libgtk-3-bin", "dconf-cli"])',
    );
    expect(module).toContain(
      `Download(url="https://downloads.example.com/varicad.deb", sha256="${sha256}", to="vendor/package.deb", arch="amd64")`,
    );
    expect(module).toContain(
      `Download(url="https://releases.example.com/rea.tar.xz", sha256="${"b".repeat(64)}", to="rea-payload.tar")`,
    );
    expect(module).toContain('"arch": ["amd64"]');
    expect(module).not.toContain('to="node-arm64.tar.xz"');
    // REA's layer keeps the .deb for the capture before the install removes it.
    expect(module).toContain(
      'run=[RunScript(script="install-rea.sh"), RunScript(script="install-package.sh")]',
    );
    expect(text(bundle.files, "envs/mousepad/install-rea.sh")).toContain(
      `cp vendor/package.deb ${BUILD_PACKAGE_FILE}`,
    );
    expect(BUILD_PACKAGE_FILE).toBe("/opt/rea/package.deb");
    expect(text(bundle.files, "envs/mousepad/install-package.sh")).toContain(
      "dpkg -i 'vendor/package.deb'",
    );
    expect(
      bundle.files.some((file) => file.path.endsWith("rea-payload.tar")),
    ).toBe(false);
  });

  it("admits only what agentenv can install from", () => {
    const parse = (value: unknown) => buildSourceSchema.safeParse(value);
    expect(
      parse({
        kind: "request",
        desktop_entry: "../evil",
        install: { kind: "archive", package: "mousepad" },
      }).success,
    ).toBe(false);
    expect(
      parse({
        kind: "request",
        desktop_entry: "mousepad",
        install: {
          kind: "package_file",
          url: "https://user@example.com/a.deb",
          sha256: "a".repeat(64),
          architecture: "amd64",
        },
      }).success,
    ).toBe(false);
    expect(
      parse({
        kind: "request",
        desktop_entry: "mousepad",
        install: {
          kind: "apt_repository",
          package: "geany",
          uri: "ftp://example.com/ubuntu",
          suite: "noble",
          key_file: "/keys/geany.gpg",
        },
      }).success,
    ).toBe(false);
    expect(parse({ kind: "bundle", path: "relative/bundle" }).success).toBe(
      false,
    );
    expect(parse({ kind: "bundle", path: "/tmp/bundle" }).success).toBe(true);
  });
});

const DRAWIO_URL =
  "https://github.com/jgraph/drawio-desktop/releases/download/v32.6.10/drawio-arm64-32.6.10.AppImage";
const DRAWIO_SHA256 =
  "2b3a66339d56a87a346df52b65fc39a342da1b12b5eed80a633c3bb6c031700e";
const NOTES_URL = "https://downloads.example.com/notes-2.0-linux-arm64.tar.xz";

const appImageRequest = (desktopEntry: string): BuildRequest => ({
  kind: "request",
  desktop_entry: desktopEntry,
  electron: true,
  install: {
    kind: "appimage",
    url: DRAWIO_URL,
    sha256: DRAWIO_SHA256,
    architecture: "arm64",
    extra_packages: ["libasound2t64"],
  },
});

const tarballRequest = (program: string): BuildRequest => ({
  kind: "request",
  desktop_entry: "org.example.Notes",
  install: {
    kind: "tarball",
    url: NOTES_URL,
    sha256: "c".repeat(64),
    architecture: "arm64",
    program,
    name: "Example Notes",
    extra_packages: [],
  },
});

describe("build bundle download installs", () => {
  it("downloads an AppImage for its architecture and extracts it after REA's layer and before the Electron rewrite", () => {
    const source = appImageRequest("drawio");
    const bundle = renderBuildBundle(source, localPayload);
    const module = text(bundle.files, "envs/drawio/drawio_app.py");
    expect(module).toContain(
      'packages=Packages(apt=["libasound2t64", "libgtk-3-bin", "dconf-cli"])',
    );
    expect(module).toContain(
      `Download(url="${DRAWIO_URL}", sha256="${DRAWIO_SHA256}", to="vendor/app.AppImage", arch="arm64")`,
    );
    expect(module).toContain('"arch": ["arm64"]');
    expect(module).not.toContain('to="node-amd64.tar.xz"');
    // The Electron rewrite edits the desktop entry the extract step installs.
    expect(module).toContain(
      'run=[RunScript(script="install-rea.sh"), RunScript(script="install-download.sh"), RunScript(script="prepare-electron-launch.sh")]',
    );
    expect(module).toContain("exec gtk-launch 'drawio'");
    expect(text(bundle.files, "envs/drawio/install-download.sh")).toContain(
      "--appimage-extract",
    );
    expect(extraPackagesOf(source)).toEqual(["libasound2t64"]);
  });

  it("downloads a tarball and ships the desktop entry REA writes for its program", () => {
    const bundle = renderBuildBundle(
      tarballRequest("notes-2.0/bin/notes"),
      localPayload,
    );
    expect(text(bundle.files, "envs/notes/notes_app.py")).toContain(
      `Download(url="${NOTES_URL}", sha256="${"c".repeat(64)}", to="vendor/app.tar", arch="arm64")`,
    );
    expect(
      text(bundle.files, "envs/notes/applications/org.example.Notes.desktop"),
    ).toBe(
      "[Desktop Entry]\nType=Application\nName=Example Notes\nExec=/opt/rea-apps/org.example.Notes/notes-2.0/bin/notes %F\nTerminal=false\n",
    );
  });

  it("admits a download only by an http or https URL, its SHA-256 and a program inside the archive", () => {
    const install = (fields: Record<string, unknown>) =>
      buildSourceSchema.safeParse({
        kind: "request",
        desktop_entry: "org.example.Notes",
        install: {
          kind: "tarball",
          url: NOTES_URL,
          sha256: "c".repeat(64),
          architecture: "arm64",
          program: "notes-2.0/bin/notes",
          ...fields,
        },
      }).success;
    expect(install({})).toBe(true);
    expect(install({ program: "../bin/sh" })).toBe(false);
    expect(install({ program: "/usr/bin/notes" })).toBe(false);
    expect(install({ program: "notes//notes" })).toBe(false);
    expect(install({ sha256: "C".repeat(64) })).toBe(false);
    expect(install({ url: "ftp://downloads.example.com/notes.tar.xz" })).toBe(
      false,
    );
    expect(install({ name: "Notes\nExec=/bin/sh" })).toBe(false);
    expect(install({ architecture: "armhf" })).toBe(false);
    expect(
      buildSourceSchema.safeParse({
        kind: "request",
        desktop_entry: "drawio",
        install: {
          kind: "appimage",
          url: "https://user:secret@example.com/drawio.AppImage",
          sha256: DRAWIO_SHA256,
          architecture: "arm64",
        },
      }).success,
    ).toBe(false);
  });
});

/** Run a rendered download install as the computer would, with its absolute folders moved under `root`. */
const runDownloadInstall = async (
  bundle: ReturnType<typeof renderBuildBundle>,
  root: string,
) => {
  const environment = join(root, "env");
  const moved = (content: string) =>
    content
      .replaceAll("/opt/rea-apps", join(root, "opt/rea-apps"))
      .replaceAll("/usr/local/share", join(root, "local-share"));
  for (const file of bundle.files) {
    const path = file.path.replace(`envs/${bundle.name}/`, "");
    if (typeof file.content !== "string" || path === file.path) continue;
    await mkdir(dirname(join(environment, path)), { recursive: true });
    await writeFile(join(environment, path), moved(file.content));
  }
  return execute("sh", ["install-download.sh"], { cwd: environment });
};

const STUB_APPIMAGE = `#!/bin/sh
[ "$1" = "--appimage-extract" ] || exit 9
mkdir -p squashfs-root
printf '#!/bin/sh\\necho draw.io\\n' > squashfs-root/AppRun
chmod 700 squashfs-root/AppRun
printf '%s\\n' '[Desktop Entry]' 'Name=draw.io' 'Exec=drawio %U' 'TryExec=drawio' 'Icon=drawio' '' '[Desktop Action New]' 'Exec="drawio" --new-window' > squashfs-root/drawio.desktop
printf '<svg/>\\n' > squashfs-root/drawio.svg
`;

/** A tarball holding the program and a link out of the folder: a hardlink to `<outside>/passwd` then a file written through it, or a symlink to `<outside>`. */
const CRAFTED_TARBALL = `
import io, sys, tarfile
path, outside, link = sys.argv[1:4]

def add(archive, name, data=None, **fields):
    member = tarfile.TarInfo(name)
    for key, value in fields.items():
        setattr(member, key, value)
    member.size = 0 if data is None else len(data)
    archive.addfile(member, None if data is None else io.BytesIO(data))

with tarfile.open(path, "w:gz") as archive:
    add(archive, "notes-2.0/bin/notes", b"#!/bin/sh\\n", mode=0o755)
    if link == "hardlink":
        add(archive, "notes-2.0/etc", type=tarfile.LNKTYPE, linkname=outside + "/passwd")
        add(archive, "notes-2.0/etc", b"overwritten\\n")
    else:
        add(archive, "notes-2.0/etc", type=tarfile.SYMTYPE, linkname=outside)
`;

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A temporary root with the environment folder's `vendor` folder, where agentenv puts a download. */
const stage = async (prefix: string) => {
  const root = await createTestTempDirectory(prefix);
  await mkdir(join(root, "env/vendor"), { recursive: true });
  return root;
};

describe("download install scripts", () => {
  it("extracts an AppImage under its folder and installs its own entry with an absolute Exec, its icon and no TryExec", async () => {
    const root = await stage("rea-appimage-install-");
    const image = join(root, "env/vendor/app.AppImage");
    await writeFile(image, STUB_APPIMAGE);
    await chmod(image, 0o755);
    await runDownloadInstall(
      renderBuildBundle(appImageRequest("drawio"), localPayload),
      root,
    );

    const appRun = join(root, "opt/rea-apps/drawio/squashfs-root/AppRun");
    expect(
      await readFile(join(root, "local-share/applications/drawio.desktop"), {
        encoding: "utf8",
      }),
    ).toBe(
      `[Desktop Entry]\nName=draw.io\nExec=${appRun} %U\nIcon=drawio\n\n[Desktop Action New]\nExec=${appRun} --new-window\n`,
    );
    expect(
      await exists(
        join(root, "local-share/icons/hicolor/scalable/apps/drawio.svg"),
      ),
    ).toBe(true);
    // The session user runs what root extracted.
    expect((await stat(appRun)).mode & 0o055).toBe(0o055);
    expect(await exists(image)).toBe(false);
  });

  it("fails the build when the AppImage ships no entry by the requested name, naming those it ships", async () => {
    const root = await stage("rea-appimage-entry-");
    const image = join(root, "env/vendor/app.AppImage");
    await writeFile(image, STUB_APPIMAGE);
    await chmod(image, 0o755);
    const failed = await runDownloadInstall(
      renderBuildBundle(appImageRequest("com.example.Other"), localPayload),
      root,
    ).then(
      () => undefined,
      (error: unknown) => error as { stderr: string },
    );
    expect(failed?.stderr).toContain("com.example.Other.desktop");
    expect(failed?.stderr).toContain("drawio.desktop");
  });

  it("keeps an env prefix and its assignments when it points the AppImage's entry at AppRun", async () => {
    const root = await stage("rea-appimage-env-");
    const image = join(root, "env/vendor/app.AppImage");
    await writeFile(
      image,
      STUB_APPIMAGE.replace(
        "'Exec=drawio %U'",
        "'Exec=env QT_QPA_PLATFORM=xcb \"GTK_THEME=Adwaita dark\" drawio %U'",
      ),
    );
    await chmod(image, 0o755);
    await runDownloadInstall(
      renderBuildBundle(appImageRequest("drawio"), localPayload),
      root,
    );

    const appRun = join(root, "opt/rea-apps/drawio/squashfs-root/AppRun");
    expect(
      await readFile(
        join(root, "local-share/applications/drawio.desktop"),
        "utf8",
      ),
    ).toContain(
      `\nExec=env QT_QPA_PLATFORM=xcb "GTK_THEME=Adwaita dark" ${appRun} %U\n`,
    );
  });

  it("unpacks a tarball without xz under its folder and installs the entry REA wrote for its program", async () => {
    const root = await stage("rea-tarball-install-");
    const program = join(root, "src/notes-2.0/bin/notes");
    await mkdir(dirname(program), { recursive: true });
    await writeFile(program, "#!/bin/sh\necho notes\n");
    await chmod(program, 0o755);
    await execute("tar", [
      "-cJf",
      join(root, "env/vendor/app.tar"),
      "-C",
      join(root, "src"),
      "notes-2.0",
    ]);
    await runDownloadInstall(
      renderBuildBundle(tarballRequest("notes-2.0/bin/notes"), localPayload),
      root,
    );

    const installed = join(
      root,
      "opt/rea-apps/org.example.Notes/notes-2.0/bin/notes",
    );
    expect(await readFile(installed, "utf8")).toBe("#!/bin/sh\necho notes\n");
    expect(
      await readFile(
        join(root, "local-share/applications/org.example.Notes.desktop"),
        "utf8",
      ),
    ).toContain(`Exec=${installed} %F\n`);
    expect(await exists(join(root, "env/vendor/app.tar"))).toBe(false);

    const missing = await stage("rea-tarball-program-");
    await execute("tar", [
      "-cJf",
      join(missing, "env/vendor/app.tar"),
      "-C",
      join(root, "src"),
      "notes-2.0",
    ]);
    const failed = await runDownloadInstall(
      renderBuildBundle(tarballRequest("notes-2.0/notes"), localPayload),
      missing,
    ).then(
      () => undefined,
      (error: unknown) => error as { stderr: string },
    );
    expect(failed?.stderr).toContain("notes-2.0/notes");
    expect(failed?.stderr).toContain("notes-2.0");
  });
});

describe("download install scripts and archive links", () => {
  it("refuses a tarball whose links point outside its folder, leaving the files they name untouched", async () => {
    for (const link of ["hardlink", "symlink"]) {
      const root = await stage(`rea-tarball-${link}-`);
      const outside = join(root, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "passwd"), "kept\n");
      await execute("python3", [
        "-I",
        "-c",
        CRAFTED_TARBALL,
        join(root, "env/vendor/app.tar"),
        outside,
        link,
      ]);
      const failed = await runDownloadInstall(
        renderBuildBundle(tarballRequest("notes-2.0/bin/notes"), localPayload),
        root,
      ).then(
        () => undefined,
        (error: unknown) => error as { stderr: string },
      );

      expect(await readFile(join(outside, "passwd"), "utf8"), link).toBe(
        "kept\n",
      );
      const placed = join(root, "opt/rea-apps/org.example.Notes/notes-2.0/etc");
      expect(
        await lstat(placed).then(
          (entry) => entry.isSymbolicLink() || entry.nlink > 1,
          () => false,
        ),
        link,
      ).toBe(false);
      expect(failed?.stderr ?? "", link).toContain("notes-2.0/etc");
    }
  });
});

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

describe("installed launch paths", () => {
  it("keeps an archive folder with spaces as the rea entrypoint", async () => {
    const root = await createTestTempDirectory("rea-launcher-spaces-");
    const nodeDir = join(
      root,
      "node-src",
      `node-v${BUILD_NODE_VERSION}-linux-x64`,
      "bin",
    );
    const payloadDir = join(root, "payload-src", "REA Build", "scripts");
    await mkdir(nodeDir, { recursive: true });
    await mkdir(payloadDir, { recursive: true });
    const marker = join(root, "node-args");
    const entrypoint = "export const marker = 'rea-entrypoint';\n";
    await writeFile(
      join(nodeDir, "node"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${shellQuote(marker)}\n`,
    );
    await chmod(join(nodeDir, "node"), 0o755);
    await writeFile(join(payloadDir, "rea.mjs"), entrypoint);
    await execute("tar", [
      "-cJf",
      join(root, "node-amd64.tar.xz"),
      "-C",
      join(root, "node-src"),
      `node-v${BUILD_NODE_VERSION}-linux-x64`,
    ]);
    await execute("tar", [
      "-cf",
      join(root, "rea-payload.tar"),
      "-C",
      join(root, "payload-src"),
      "REA Build",
    ]);
    const bundle = renderBuildBundle(
      request({ kind: "archive", package: "mousepad", extra_packages: [] }),
      localPayload,
    );
    const script = text(bundle.files, "envs/mousepad/install-rea.sh")
      .replaceAll("/opt/rea", join(root, "opt/rea"))
      .replaceAll("/usr/local/bin", join(root, "bin"));
    await mkdir(join(root, "bin"), { recursive: true });
    const scriptPath = join(root, "install-rea.sh");
    await writeFile(scriptPath, script);
    await chmod(scriptPath, 0o755);
    await execute("sh", [scriptPath], { cwd: root });

    const linked = join(root, "opt/rea/rea.mjs");
    expect(await readlink(linked)).toBe(
      join(root, "opt/rea/payload/REA Build/scripts/rea.mjs"),
    );
    expect(await readFile(linked, "utf8")).toBe(entrypoint);
    await execute(join(root, "bin/rea"), ["--version"]);
    expect(await readFile(marker, "utf8")).toBe(`${linked}\n--version\n`);
  });

  it("rewrites an Electron desktop command with the shared launch policy", async () => {
    const bundle = renderBuildBundle(
      {
        ...request({ kind: "archive", package: "typora", extra_packages: [] }),
        desktop_entry: "typora.desktop",
        electron: true,
      },
      localPayload,
    );
    expect(bundle.files.map((file) => file.path).sort()).toContain(
      "envs/typora/prepare-electron-launch.sh",
    );
    const module = text(bundle.files, "envs/typora/typora_app.py");
    expect(module).toContain(
      `launch=Launch(at="demand", command=["sh", "-c", "cd \\"$HOME\\" 2>/dev/null; exec gtk-launch 'typora'"]),`,
    );
    expect(module).toContain(
      'run=[RunScript(script="install-rea.sh"), RunScript(script="prepare-electron-launch.sh")]',
    );
    const plain = renderBuildBundle(
      {
        ...request({ kind: "archive", package: "typora", extra_packages: [] }),
        desktop_entry: "typora",
        electron: false,
      },
      localPayload,
    );
    expect(
      plain.files.some((file) =>
        file.path.endsWith("prepare-electron-launch.sh"),
      ),
    ).toBe(false);

    const root = await createTestTempDirectory("rea-electron-launch-");
    const policy = join(
      root,
      "opt/rea/payload/rea/dist/domain/desktop/appExportInstall.js",
    );
    await mkdir(dirname(policy), { recursive: true });
    const source = fileURLToPath(
      new URL("./appExportInstall.ts", import.meta.url),
    );
    await writeFile(
      policy,
      `export { adjustInstalledDesktopText } from ${JSON.stringify(source)};\n`,
    );
    const applications = join(root, "share/applications");
    await mkdir(applications, { recursive: true });
    const desktop = join(applications, "typora.desktop");
    const original = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Typora",
      "Exec=typora %U",
      "[Desktop Action New]",
      "Name=New Window",
      "Exec=typora --new-window",
      "",
    ].join("\n");
    await writeFile(desktop, original);
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "node"),
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} --import tsx "$@"\n`,
    );
    await chmod(join(bin, "node"), 0o755);
    const script = text(bundle.files, "envs/typora/prepare-electron-launch.sh")
      .replaceAll("/opt/rea", join(root, "opt/rea"))
      .replaceAll("/usr/local/bin", bin);
    const scriptPath = join(root, "prepare-electron-launch.sh");
    await writeFile(scriptPath, script);
    await chmod(scriptPath, 0o755);
    await execute("sh", [scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, XDG_DATA_DIRS: join(root, "share") },
    });

    expect(await readFile(desktop, "utf8")).toBe(
      original.replace("Exec=typora %U", "Exec=typora --no-sandbox %U"),
    );
  });
});
