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
  passed, with no lint or typed-lint diagnostics and no duplicate blocks in
  the touched files.
- `npx vitest run src/domain/desktop src/application/desktop src/desktop
  src/process/TokenOwnedTermination.test.ts` on macOS and in the container,
  and the CLI boundary tests `cliInputSchemaRequired`, `cliToolCoverage` and
  `cliStartupImports`: passed.
- New tests: the sources parsers on Ubuntu 24.04's own `ubuntu.sources`,
  Typora's flat entry and `[arch=… signed-by=…]` options; apt list file
  names; gpgv VALIDSIG and ERRSIG status from the container; ASCII armor;
  DT_NEEDED, RUNPATH over RPATH, static and malformed images; the library walk
  on `ldconfig -p` lines from the container; the inventory with a fake query
  runner (binary and armored keys, gpgv and ldconfig missing, no key
  verifying); key retention within and over the content budget; the install
  decision and its limitations; the renderers; the export service writing a
  vendor bundle and refusing an unverified key. On Linux, the library
  inventory maps the node binary's libraries with the host's `ldconfig` and
  `dpkg-query`.

## Typora

- The inventory, run as a normal user in the container, recorded the
  repository from `/etc/apt/sources.list.d/typora.list` with
  `/etc/apt/trusted.gpg.d/typora.gpg` (fingerprint
  `4AC441BE68B4ADAB7439FBF9BA300B7755AFCFAE`) verified by gpgv against
  `downloads.typora.io_linux_._InRelease`, 85 library packages, no missing or
  unpackaged libraries, in 1.3 s, and left no temporary folder. With the key
  converted to an armored `typora.asc`, and with it moved to
  `/usr/share/keyrings/typora.gpg` named by `[signed-by=…]`, the same key was
  verified.
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

## Limits of this verification

- The bundle was not deployed: no image was built and Typora did not boot in a
  computer, so `--no-sandbox` inside the computer is untested here.
- The export's own `--no-sandbox` insertion was checked in tests; the real
  capture already had it, since Typora does not start in the container
  without it.
- Library packages were mapped on Ubuntu 24.04 only.
