import { z } from "zod";

import { rewriteAppImageDesktop } from "./appDownloadDesktop.js";

/** The Debian architectures an agentenv computer runs. */
export const COMPUTER_ARCHITECTURES = ["amd64", "arm64"] as const;

/** A URL agentenv downloads from: http or https in lowercase, without a user name or password. */
export const downloadUrlSchema = z
  .url({ protocol: /^https?$/u, abort: true })
  .regex(/^https?:\/\//u)
  .refine(
    (url) => {
      const parsed = new URL(url);
      return parsed.username === "" && parsed.password === "";
    },
    { message: "The URL must not hold a user name or password." },
  );
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

/** A file of an archive, by its path from the archive's top: segments that start with neither a dot nor a slash. */
const archivePathSchema = z
  .string()
  .max(255)
  .regex(
    /^[A-Za-z0-9_+@\x2d][A-Za-z0-9._+@\x2d]*(?:\/[A-Za-z0-9_+@\x2d][A-Za-z0-9._+@\x2d]*)*$/u,
  );

/** The fields every download names: where it is, its SHA-256 and the one architecture it runs on. */
export const downloadFields = {
  url: downloadUrlSchema.describe(
    "Where the computer downloads the file when the bundle is put: a release URL that keeps serving these bytes.",
  ),
  sha256: sha256Schema.describe(
    "The file's SHA-256, as its project publishes it; agentenv refuses any other bytes.",
  ),
  architecture: z
    .enum(COMPUTER_ARCHITECTURES)
    .describe("The architecture the file is built for."),
};

/** A tarball's fields beside the download's: the program it runs and the name its menu entry shows. */
export const tarballFields = {
  ...downloadFields,
  program: archivePathSchema.describe(
    "The program to run, by its path inside the archive, such as firefox/firefox.",
  ),
  name: z
    .string()
    .min(1)
    .max(128)
    .refine(
      (name) =>
        [...name].every((character) => {
          const code = character.codePointAt(0) ?? 0;
          return code >= 0x20 && code !== 0x7f;
        }),
      { message: "The name must be one line without control characters." },
    )
    .optional()
    .describe(
      "The name the menu entry REA writes shows; the desktop entry's last part when omitted.",
    ),
};

const desktopEntryId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\x2d]*$/u)
  .max(255)
  .transform((id) => id.replace(/\.desktop$/u, ""));

/** An app the computer downloads and unpacks, with the desktop entry that launches it: as a build request names it, and as the export takes it with `--download-install`. */
export const downloadInstallSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("appimage"),
    desktop_entry: desktopEntryId,
    ...downloadFields,
  }),
  z.strictObject({
    kind: z.literal("tarball"),
    desktop_entry: desktopEntryId,
    ...tarballFields,
  }),
]);
export type DownloadInstall = z.output<typeof downloadInstallSchema>;

/** The run script that unpacks a download, shared by the build computer and the export. */
export const DOWNLOAD_INSTALL_SCRIPT = "install-download.sh";
const APPLICATIONS = "/usr/local/share/applications";

/** The folder a download unpacks into, named after its desktop entry. */
export const downloadPrefix = (
  install: Pick<DownloadInstall, "desktop_entry">,
) => `/opt/rea-apps/${install.desktop_entry}`;

/** Where agentenv puts the download in the environment folder. */
export const downloadedFile = (install: Pick<DownloadInstall, "kind">) =>
  install.kind === "appimage" ? "vendor/app.AppImage" : "vendor/app.tar";

/** The program the installed desktop entry runs. */
export const downloadedProgram = (install: DownloadInstall): string =>
  install.kind === "appimage"
    ? `${downloadPrefix(install)}/squashfs-root/AppRun`
    : `${downloadPrefix(install)}/${install.program}`;

/** A validated value as one single-quoted shell word; refused when it is not one REA's schemas admit. */
const word = (value: string): string => {
  if (!/^[A-Za-z0-9._/+@-]+$/u.test(value))
    throw new TypeError(`${JSON.stringify(value)} is not a download path.`);
  return `'${value}'`;
};

const scriptHead = (install: DownloadInstall, purpose: string) => [
  "#!/bin/sh",
  `# Runs as root with the network off: ${purpose}`,
  "set -eu",
  `download="$PWD"/${word(downloadedFile(install))}`,
  `entry=${word(install.desktop_entry)}`,
  `prefix=${word(downloadPrefix(install))}`,
  'rm -rf "$prefix"',
  `mkdir -p "$prefix" ${APPLICATIONS}`,
];

const appImageScript = (install: DownloadInstall): string =>
  [
    ...scriptHead(
      install,
      "extract the AppImage under its folder and install its own desktop entry and icon.",
    ),
    'cd "$prefix"',
    '[ -x "$download" ] || chmod 755 "$download"',
    '"$download" --appimage-extract > /dev/null',
    'rm -f "$download"',
    'desktop="squashfs-root/$entry.desktop"',
    'if [ ! -f "$desktop" ]; then',
    `  echo "The AppImage has no desktop entry $entry.desktop at its top; it has: $(cd squashfs-root && ls -- *.desktop 2>/dev/null | tr '\\n' ' ')" >&2`,
    "  exit 1",
    "fi",
    'chmod -R a+rX "$prefix"',
    // The installer and export share this format-aware rewrite.
    `python3 - "$desktop" "${APPLICATIONS}/$entry.desktop" "$prefix/squashfs-root/AppRun" <<'PY'`,
    rewriteAppImageDesktop,
    "PY",
    `icon=$(sed -n 's/^Icon=//p' "$desktop" | head -n 1)`,
    'case "$icon" in',
    "  '' | */*) ;;",
    "  *)",
    '    if [ -f "squashfs-root/$icon.svg" ]; then',
    "      mkdir -p /usr/local/share/icons/hicolor/scalable/apps",
    '      cp "squashfs-root/$icon.svg" /usr/local/share/icons/hicolor/scalable/apps/',
    '    elif [ -f "squashfs-root/$icon.png" ]; then',
    "      mkdir -p /usr/local/share/pixmaps",
    '      cp "squashfs-root/$icon.png" /usr/local/share/pixmaps/',
    "    fi",
    "    ;;",
    "esac",
    "",
  ].join("\n");

/** Where a tarball's desktop entry is kept in the environment folder. */
const tarballEntryFile = (install: DownloadInstall) =>
  `applications/${install.desktop_entry}.desktop`;

const tarballScript = (
  install: Extract<DownloadInstall, { kind: "tarball" }>,
): string =>
  [
    ...scriptHead(
      install,
      "unpack the archive under its folder and install the desktop entry REA wrote for its program.",
    ),
    `program=${word(install.program)}`,
    // Python's tarfile reads gzip, bzip2 and xz, and the computer has no xz program; its data filter refuses links out of the folder.
    'python3 - "$download" "$prefix" <<\'PY\'',
    "import sys",
    "import tarfile",
    "",
    "with tarfile.open(sys.argv[1]) as archive:",
    '    archive.extractall(sys.argv[2], filter="data")',
    "PY",
    'rm -f "$download"',
    'if [ ! -f "$prefix/$program" ] || [ ! -x "$prefix/$program" ]; then',
    `  echo "The archive has no executable $program; its top holds: $(ls "$prefix" | tr '\\n' ' ')" >&2`,
    "  exit 1",
    "fi",
    'chmod -R a+rX "$prefix"',
    `cp "$PWD"/${word(tarballEntryFile(install))} "${APPLICATIONS}/$entry.desktop"`,
    `chmod 644 "${APPLICATIONS}/$entry.desktop"`,
    "",
  ].join("\n");

/** A tarball's menu entry: its name, and its program with the files it opens. */
const tarballEntry = (
  install: Extract<DownloadInstall, { kind: "tarball" }>,
): string => {
  const name = install.name ?? install.desktop_entry.split(".").at(-1) ?? "app";
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${name.replaceAll("\\", "\\\\")}`,
    `Exec=${downloadedProgram(install)} %F`,
    "Terminal=false",
    "",
  ].join("\n");
};

/** The files a download adds to the environment folder: the script that unpacks it, and a tarball's desktop entry. */
export const downloadInstallFiles = (
  install: DownloadInstall,
): readonly { readonly path: string; readonly content: string }[] =>
  install.kind === "appimage"
    ? [{ path: DOWNLOAD_INSTALL_SCRIPT, content: appImageScript(install) }]
    : [
        { path: DOWNLOAD_INSTALL_SCRIPT, content: tarballScript(install) },
        { path: tarballEntryFile(install), content: tarballEntry(install) },
      ];
