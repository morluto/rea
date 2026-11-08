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
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  parseDesktopEntry,
  tokenizeDesktopExec,
  unwrapDesktopCommand,
} from "../../../src/domain/desktop/desktopEntry.js";
import {
  BUILD_NODE_VERSION,
  renderBuildBundle,
} from "../../../src/domain/desktop/appBuild.js";
import {
  request,
  localPayload,
  text,
  appImageRequest,
  tarballRequest,
} from "../../../src/domain/desktop/appBuild.fixture.js";

const execute = promisify(execFile);

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

  it("points an Exec spaced around its = at AppRun and drops a spaced TryExec, as the desktop entry parser reads them", async () => {
    const root = await stage("rea-appimage-spaced-");
    const image = join(root, "env/vendor/app.AppImage");
    await writeFile(
      image,
      STUB_APPIMAGE.replace(
        "'Exec=drawio %U' 'TryExec=drawio'",
        "'Exec = drawio %U' '  TryExec =drawio'",
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
    ).toBe(
      `[Desktop Entry]\nName=draw.io\nExec=${appRun} %U\nIcon=drawio\n\n[Desktop Action New]\nExec=${appRun} --new-window\n`,
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
    const root = await createTestTempDirectory("rea-electron-launch-");
    const policy = join(
      root,
      "opt/rea/payload/rea/dist/domain/desktop/appExportInstall.js",
    );
    await mkdir(dirname(policy), { recursive: true });
    const source = fileURLToPath(
      new URL(
        "../../../src/domain/desktop/appExportInstall.ts",
        import.meta.url,
      ),
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

it("preserves a quoted env executable when rewriting an AppImage entry", async () => {
  const root = await stage("rea-appimage-quoted-env-");
  const image = join(root, "env/vendor/app.AppImage");
  await writeFile(
    image,
    STUB_APPIMAGE.replace(
      "'Exec=drawio %U'",
      "'Exec=\"/usr/bin/env\" QT_QPA_PLATFORM=xcb drawio %U'",
    ),
  );
  await chmod(image, 0o755);
  await runDownloadInstall(
    renderBuildBundle(appImageRequest("drawio"), localPayload),
    root,
  );
  const text = await readFile(
    join(root, "local-share/applications/drawio.desktop"),
    "utf8",
  );
  expect(text).toContain(
    `Exec="/usr/bin/env" QT_QPA_PLATFORM=xcb ${join(root, "opt/rea-apps/drawio/squashfs-root/AppRun")} %U`,
  );
  const parsed = parseDesktopEntry(text);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("invalid desktop entry");
  const tokens = tokenizeDesktopExec(parsed.value.exec ?? "");
  expect(tokens.ok).toBe(true);
  if (!tokens.ok) throw new Error("invalid Exec");
  expect(unwrapDesktopCommand(tokens.value)).toMatchObject({
    kind: "direct",
    environment: { QT_QPA_PLATFORM: "xcb" },
    program: join(root, "opt/rea-apps/drawio/squashfs-root/AppRun"),
  });
});
