# Verification

Run on 2026-11-06 and 2026-11-07 on top of the build-and-witness branch:
gates and source tests on macOS with Node v22.23.1; real builds on an arm64
Ubuntu 24.04 host with agentenv-framework 0.9.1431 and Docker. No amd64 host
was available, so amd64 is unverified; FreeCAD, VSCodium and draw.io publish
x86_64 builds of the same releases.

## Gates

- `npm run typecheck`: no errors outside `src/domain/apiContract`, whose
  `graphql` dependency is missing here, as before the change.
- `npx oxfmt --check .`: clean.
- oxlint on the changed and new source and test files: no diagnostics. The
  first version added size warnings (`max-lines` on `appExport.ts`,
  `appExportInstall.ts` and `DesktopApplicationExport.ts`, function length,
  `max-params`); the README install text moved to `appExportInstallText.ts`,
  the export's decision to `appExportDownload.ts`, and `admitApplication`
  takes an options object.
- `npx knip`: the same two unresolved worker aliases as before the change,
  which need build artifacts; nothing new.
- `npm run verify:module-boundaries`: passed.
- `npx vitest run src/domain/desktop src/application/desktop
  tests/boundary/providers tests/boundary/mcp/build tests/boundary/cli/desktop
  tests/boundary/mcp/advertisedPatternsVMode.test.ts`: 12 files and 51 tests
  fail, the same files and tests as on the unchanged branch (Ghidra, IDA,
  Kuna, ADB and SQLite provider tests, and two desktop CLI tests, which need
  tools or a build this host lacks); 11 more tests pass.

## Tests

Each failed on the unchanged code first:

- the bundle declares an AppImage's `Download` for its architecture, runs
  `install-download.sh` after REA's layer and before the Electron rewrite,
  and passes its `extra_packages` (the request was rendered as an archive);
- a tarball's `Download` and the entry REA writes for its program;
- the schema refuses a program outside the archive, an uppercase SHA-256, a
  URL with credentials or not over http or https, a two-line name and another
  architecture;
- the AppImage script, run under `sh` against a stub AppImage, installs its
  entry with each `Exec` program replaced by `AppRun`, no `TryExec`, its SVG
  icon, a readable folder and no download (the script did not exist);
- an image without the requested entry fails, naming those it has;
- the tarball script unpacks a real `.tar.xz` with Python, installs the entry
  and removes the download; a missing program fails, naming the archive's top;
- the export from `--download-install` declares the download and writes the
  same script the build computer ran; a tarball's entry is written beside it
  (the export refused the capture as not an apt package);
- the export refuses a program outside `/opt/rea-apps/<entry>`, writing
  nothing, `--package-url` beside the download, and a file naming no download;
- through MCP, an AppImage request's export receives `--download-install`
  with the request's download in a file, and its bundle downloads the image.

After review, three more, each failing on the first version:

- a URL holding `"`, `\` and `"""` ended the class's docstring and made the
  module invalid Python; now the docstring shows it with those characters
  replaced, Python parses one expression, the docstring, and `Download`'s
  literal holds the exact URL;
- an entry's `Exec=env QT_QPA_PLATFORM=xcb "GTK_THEME=Adwaita dark" drawio %U`
  lost its `env` prefix; it now keeps both assignments before `AppRun`;
- a crafted tarball with an absolute hardlink, then a file of the same name,
  overwrote the outside file through the link as the script ran; with the
  `data` filter it and a symlink out of the folder fail the build, and the
  outside file keeps its content.

## FreeCAD 1.1.4 (AppImage)

The request named the release's aarch64 AppImage and its published SHA-256.
The start took 714 s, 436 s of them waiting for other agents' builds; the
resolve took 35 s since agentenv had stored the 756 MB image, and the image
build 205 s. The capture opened FreeCAD in 7.7 s and recorded its package as
`unknown`. A seed of a cube and a cylinder in `Documents/block.FCStd`, and the
cube's Length changed from 10 to 25 mm, gave a draft check on
`Document.xml`'s `Box` Length through the `.FCStd` view. The export declared
the download with no apt package, its `install-download.sh` byte-identical to
the build computer's, and a boot launch of `AppRun` on the document.

The bundle's computer started in 267 s. agentenv's probe passed with FreeCAD
launched at boot, so the boot launch needs nothing from REA. The witness held:
the seed failed the Length check, the edit passed all three checks, 24 mm
failed, and the reset restored 10 mm.

## VSCodium 1.143.17232 (tarball)

The request named `VSCodium-linux-arm64-1.143.17232.tar.gz`, its published
SHA-256 and `program: codium`, with `electron: true`. The first computer's
installed entry read `Exec=/opt/rea-apps/codium/codium --no-sandbox %F`, so
the Electron rewrite ran on the entry the download step wrote. Its capture
failed with `libnspr4.so: cannot open shared object file`; `ldd` named NSS
and ALSA, and a new computer with `extra_packages: ["libnss3",
"libasound2t64"]` ran it. VSCodium's main process runs without REA's run
token, so a capture stopped while it ran failed to clean up and left its
window crashed; quitting it with Ctrl+Q after `end` lets the capture stop.
The skill says so. A list in `Documents/todo.txt` with "olive oil" added
exported with its two packages, the tarball download, REA's entry and an
Electron launch. The witness computer passed the probe with VSCodium at boot,
and the witness held: seed, edit, "olive oils" as the near miss, reset.

## draw.io 32.6.10 (`.deb`, unchanged path)

The upstream arm64 `.deb` with its Depends and `libasound2t64`, which it
lacks, built through `package_file`; agentenv resolved the virtual
`libgtk-3-0`. A box renamed from Draft to Approved exported with
`install-package.sh`, and the witness held all four stages.

## Not verified

- amd64 builds, and AppImages without `--appimage-extract` (type 1).
- A zstd tarball, which the script refuses through Python's `tarfile`.
- Flatpak, out of scope: bubblewrap failed in the computer with `No
  permissions to create new namespace`, and with seccomp and AppArmor
  unconfined still failed on the host's
  `kernel.apparmor_restrict_unprivileged_userns=1`.
