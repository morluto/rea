# Verification

Run on 2026-11-04 on top of the export branch: gates and source tests on
macOS with Node v22.23.1; Linux runs in an Ubuntu 24.04 arm64 container with
Node v24.22.1 and Typora 1.14.9-1 installed from
`https://downloads.typora.io/linux` as Typora's instructions say (key in
`/etc/apt/trusted.gpg.d/typora.gpg`, `deb https://downloads.typora.io/linux ./`),
plus the Electron runtime libraries and gnupg.

## Gates

- `npm run typecheck`, `lint`, `lint:typed`, `format:check`, `knip` (after
  `build:cached`, which its `#…-worker` imports resolve into), `jscpd`,
  `docs:check`, `verify:test-discovery` and `verify:architecture-guards`:
  passed, with no lint or typed-lint diagnostics in the touched files; jscpd
  reports one 8-line block, the private folder's release in `GpgvKeyCheck`,
  which follows `DesktopApplicationState`'s use of `ArtifactResourceScope`.
- `npx vitest run src/domain/desktop src/application/desktop src/desktop
  src/process/TokenOwnedTermination.test.ts` on macOS and in the container,
  and the CLI boundary tests `cliInputSchemaRequired`, `cliToolCoverage` and
  `cliStartupImports`: passed.
- New tests: the sources parsers on Ubuntu 24.04's own `ubuntu.sources`,
  Typora's flat entry and `[arch=… signed-by=…]` options, with apt's entry
  positions; `apt-get indextargets` output from the containers for Typora's
  `./`, pkgs.k8s.io's `/` and Ubuntu's suites, and the release file names it
  gives; gpgv status for a release signed by two keys and checked with one
  (exit 2), and bad, expired and revoked signatures; the OpenPGP keyring
  splitter on GnuPG-made keys, OpenPGP.js rewrites of them with new-format
  headers, and refused malformed packets; ASCII armor; DT_NEEDED, RUNPATH
  over RPATH, a table repeating one name 60,000 times and one naming 513;
  the library walk on `ldconfig -p` lines from the container, a normalized
  `$ORIGIN/..` path and inherited RPATH; `apt-cache policy` for several
  packages; the inventory with a fake query runner (binary, armored and
  multi-key keyrings, a flat `/` suite, an ESM repository, gpgv and ldconfig
  missing, no key verifying, an archive package not walked, a PPA library
  package set aside); with real gpgv, the two-signature release and a
  two-key keyring; a keyring folder whose removal fails keeping its owner,
  and the capture's failure keeping it; key retention within and over the
  content budget and the per-file limit; the install decision (one source per
  URI and suite, the release, the host's architecture, an `env`-wrapped
  Electron launch) and its limitations; the renderers; the exported `_sqlite`
  under python3 waiting out a 20 ms write lock and reporting a lasting one in
  about 0.3 s; the export service writing a vendor bundle and refusing an
  unverified key. On Linux, the library inventory maps the node binary's
  libraries with the host's `ldconfig` and `dpkg-query`.

## Typora

- The inventory, run as a normal user in the container, recorded the
  repository from `/etc/apt/sources.list.d/typora.list` with release
  `stable` and `/etc/apt/trusted.gpg.d/typora.gpg` (fingerprint
  `4AC441BE68B4ADAB7439FBF9BA300B7755AFCFAE`) verified by gpgv against
  `downloads.typora.io_linux_._InRelease`, 85 library packages all offered by
  the Ubuntu archive, no missing or unpackaged libraries, in 2.2 s, and left
  no temporary folder. With the key converted to an armored `typora.asc`, and
  with it moved to `/usr/share/keyrings/typora.gpg` named by
  `[signed-by=…]`, the same key was verified. With the key appended to a
  legacy `/etc/apt/trusted.gpg` after Ubuntu's 2018 archive key, only
  Typora's key was retained, byte for byte the original file
  (`06bbbb36…`).
- With pkgs.k8s.io's flat `/` repository added
  (`deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg]
  https://pkgs.k8s.io/core:/stable:/v1.30/deb/ /`) and kubectl installed, the
  inventory matched policy's `https://pkgs.k8s.io/core:/stable:/v1.30/deb
  Packages` to that entry (suite `/`, release `deb`, the codename, since its
  Release has no Suite) and gpgv verified its key against
  `pkgs.k8s.io_core:_stable:_v1.30_deb_InRelease`.
- apt in the container: `apt-get install -s --reinstall typora/stable`
  selected 1.14.9-1 from `Typora:stable`, `kubectl/deb` selected kubectl from
  pkgs.k8s.io, and an unknown release failed with `Release 'nosuch' for
  'typora' was not found`. Two deb822 sources for Typora's URI and suite with
  different `Signed-By` keyrings, as agentenv would write duplicate
  `AptSource`s, failed with `Conflicting values set for option Signed-By`.
  `apt-get indextargets` counted deb822 stanzas from 1, a disabled one
  included, and printed no Signed-By, which the sources entry still gives.
- A capture of Typora editing `~/Documents/trip.md` (launched with
  `--no-sandbox`, which the container needs) retained the key under
  `content/06bbbb36…`. The export wrote `envs/typora/apt-keys/typora.gpg` with
  that digest, declared `AptSource(apt="https://downloads.typora.io/linux",
  suite="./", components=[], key="apt-keys/typora.gpg")` and the 85 library
  packages after `typora`, and listed the sandbox and the repository version
  in its limitations.
- `python -m agentenv_protocol.computer._declare . typora_app.py Typora` with
  agentenv-framework 0.9.1431 exited 0 and declared the source, the packages
  and the launch; `agent-env run <bundle> --dry-run` exited 0.
- agentenv's own resolver (`resolve_in_base.py` from 0.9.1431), run with the
  bundle's packages and source in a fresh `ubuntu:24.04` container with
  python3 added, wrote the key and a `Signed-By` source, fetched Typora's
  InRelease, installed typora 1.14.9-1 with 125 packages, and `ldd` found
  every library of `/usr/share/typora/Typora`.

## Typora in an agentenv computer

The bundle from a recorded capture (Typora editing `~/Documents/trip.md`) ran
unchanged with `agent-env run <bundle> --keep --no-emulate` on local Docker
(agentenv-framework 0.9.1431, arm64):

- The build fetched `https://downloads.typora.io/linux ./ InRelease` and
  installed typora 1.14.9-1 from it with no signature warning; a control run
  with an empty keyring failed with `NO_PUBKEY BA300B7755AFCFAE`, and with the
  bundled key gpgv reported `VALIDSIG 4AC441BE68B4ADAB7439FBF9BA300B7755AFCFAE`.
- Of the 85 library packages, the computer base lacked `libasound2t64`,
  `libnspr4` and `libnss3`, which the build added; `ldd` on Typora then found
  every library.
- The app reached ready on its `typora` window. Launched without
  `--no-sandbox` it exits 133 with Chromium's namespace error.
- Driven through the computer's input operations (a task and a table row
  added, then saved), `data/get` read `Documents/trip.md` as 8 lines before and
  10 after; `data/reset` relaunched Typora and restored all 79 seeded files
  byte for byte.

## Limits of this verification

- The agentenv computer run above used the bundle exported before the review
  round: `Packages(apt=["typora", …])` and both architectures. The pinned
  `typora/stable`, single-architecture bundle was checked with apt in the
  container but not deployed.

- The export's own `--no-sandbox` insertion was checked in tests; the real
  capture already had it, since Typora does not start in the container
  without it.
- Library packages were mapped on Ubuntu 24.04 only.
