# Verification

## Tests

- `src/domain/desktop/buildSecrets.test.ts`: handles; values too short, too
  long or holding a control character; each spelling found, base64 at every
  alignment in both alphabets and a gzip file's inside included; a near miss
  and unrelated bytes not found; text and JSON redacted, member names too;
  the start of a value each of REA's cuts leaves, a draft value's, a
  reference's, a view's and a check's, hidden at any length and through an
  XML or JSON escape, as a string, a JSON member and a result's JSON text;
  ordinary text ending in `…`, such as `Please…`, left whole; an unclosed
  quote before 64 KiB of escaped quotes scanned in linear time.
- `src/application/desktop/DesktopBuildOutputRead.test.ts`: a secret the
  app's stderr or the capture's progress holds, redacted before the quote of
  their end cuts it.
- `src/desktop/BuildSecretFiles.test.ts`: the folder from `XDG_CONFIG_HOME`
  or `~/.config`; a `0600` or `0400` file read without its final line break;
  a file others can read, a symbolic link, a linked folder, a missing file
  and values it cannot type refused, no refusal quoting the value.
- `src/domain/desktop/computerActions.test.ts`, `buildWitness.test.ts` and
  `src/application/desktop/DesktopBuildActionLog.test.ts`: `type_secret`
  takes only `secret`, maps to `computer_type` and counts as an edit; the log
  keeps the handle and redacts a typed value.
- `tests/boundary/mcp/buildSecretsMcp.test.ts`, over MCP with a fake driver:
  the driver receives the value as `text` while no result holds it or an
  image; `screenshot`, a file others can read and a missing file are
  refused; a driver refusal quoting the value shows REA's words; a later
  refusal quoting it shows the handle; `witness.json` records the handle and
  a `type` holding the value redacted; and an export whose bundle holds a
  secret's value is refused, naming its files with the value redacted, and
  writes nothing, as is one holding a gzip file that expands past 64 MiB.

Each of these failed against the code before the change.

## KeePassXC on an arm64 build host

KeePassXC 2.7.6 from the Ubuntu 24.04 archive, on an arm64 Ubuntu 24.04 host
with agentenv-framework 0.9.1431 and a REA server whose `XDG_CONFIG_HOME`
held one `0600` file, `keepassxc-master`, with a made-up 30-character
password.

- Build computer: a new database's password and its confirmation were typed
  with `type_secret`; each result read `Typed the secret keepassxc-master`
  with `applied: "yes"`, and the screenshot afterwards showed 30 dots in each
  field. `type_secret` with `screenshot: true` was refused. The database was
  saved to `Documents/e-test.kdbx`, `seed` marked, a setting changed and
  `end` marked.
- Export: with a second secret file holding `keepassxc`, a string the bundle
  holds in its paths and files, the export was refused naming that handle
  and ten files, `envs/<secret:e-probe>/env.toml` among them, and no folder
  was written. With that file removed, the bundle of 10 files was written.
- Witness, in a computer of the bundle: the seeded database opened locked,
  `type_secret` and Return unlocked it, and seed, after edit, near miss and
  after reset all held. `witness.json` records the action as
  `{"secret": "keepassxc-master"}`.
- Leaks: every request, result, the driver's and REA server's logs,
  `witness.json`, the recording and the bundle (131 files) held the password
  in none of the spellings the export searches, UTF-16 included; nor did
  either computer's `docker logs` or any file in either container. A probe
  file holding the password's hex and UTF-16 was found by the same scan.

## Withheld state and consent

The real-provider observations below predate removal of shape-based credential
classification. They describe that earlier build and do not verify current behavior.

### Tests

- `src/domain/desktop/appWithheld.test.ts`: the owned files changed in the
  window, and those named; a window missing a checkpoint or out of order, or
  one a walk may have missed a change in; a path outside the owned paths;
  settings, variables and handles, a long path hashed and like paths kept
  apart, and settings that are neither Python keywords nor alike in any
  order.
- `src/application/desktop/DesktopExportWithheld.test.ts`: a withheld file
  left out of the seed, declared a secret setting from `env:`, copied aside
  and named in the README; seeding it refused without a consent and done with
  one, `consent.json` shipped; a check on it refused; the draft leaving out
  the window's files; dconf keys the window changed refused unless the seed
  holds them as before it or they are seeded with consent.
- `src/application/desktop/DesktopBuildSecrets.test.ts`: a kept file's
  handle that names a path refused, nothing written outside the folder.
- `src/desktop/BuildSecretFiles.concurrent.test.ts`: an export never given
  the handle of another whose different bytes are still being written.
- `tests/boundary/application/buildExportGzipScans.test.ts`: a gzip seed
  file decompressed once for its known-secret and size checks.
- `src/desktop/ExportedAppPython.test.ts`: `_write_withheld` writes the
  decoded bytes `0600` and `_views` leaves the file out.
- `tests/boundary/mcp/buildWithheldMcp.test.ts`: the named file's bytes kept
  as a `0600` secret and supplied to a witness's deploy by handle, a variable
  other than `REA_*` refused; a later build's bytes kept under a handle of
  their own, an earlier build's secret left as it was; consent recorded and
  required for `seed_sign_in`, and the sign-in window passed to the draft and
  the export; one sign-in checkpoint alone refused.

Each of these failed against the code before the change.

### KeePassXC on an arm64 build host

- Build: `pre-sign-in` marked, a database created with its password typed by
  handle and saved, `post-sign-in` marked, which acknowledged
  `Documents/e-test.kdbx` among its changes, then `seed`, a setting changed
  and `end`. The draft listed `withheld_files: ["Documents/e-test.kdbx"]`,
  and showed the KeeShare key KeePassXC generated as
  `<credential:private-key>`.
- Export: refused with `seed_sign_in` and no consent. Without it, the seed
  held only `keepassxc.ini`; `env.toml` set `documents_e_test_kdbx` to
  `env:REA_KEEPASSXC_DOCUMENTS_E_TEST_KDBX`; agentenv's `_declare` read the
  setting as a required `writeOnly` string; the README named the variable;
  and the host kept the database's base64 as the `0600` secret
  `rea-keepassxc-documents-e-test-kdbx`.
- Deploy without the variable: refused at the probe with
  `Unresolved env:REA_KEEPASSXC_DOCUMENTS_E_TEST_KDBX reference`.
- Witness, from a copy of the bundle with `settings` naming that handle: the
  computer wrote `Documents/e-test.kdbx`, mode `0600`, byte for byte the kept
  file; the agent opened it and unlocked it with `type_secret`; seed, after
  edit, near miss and after reset held, and the file was still there after
  the reset.
- Leaks: no host file of the run but the secret's own, 146 in all, held the
  password in any spelling; neither bundle held the database's bytes; and
  neither computer's logs nor files held the password.

- The same build, export and witness ran again on the final code with a new
  password: every stage held, and 124 host files, both bundles and both
  computers held neither the password nor the database's bytes.

### Typora 1.14.9 on an arm64 build host

- Installed from `typora_1.14.9_arm64.deb` by URL and SHA-256, on its trial.
  Its licence file was `~/.config/Typora/rXMW4iG3Bl`, hex of
  `{"SLicense":""}`; it was `mAxvdiPNmi` on an amd64 host, so the name
  differs by machine. Typora writes it at first launch, before any
  checkpoint, so the export named it in `withhold`: it was left out of the
  84-file seed, declared as `REA_TYPORA_CONFIG_TYPORA_RXMW4IG3BL`, and kept
  as the secret `rea-typora-config-typora-rxmw4ig3bl`.
- Booted from the bundle's image with a made-up licence in the setting, the
  initial state the class keeps before the app starts held the made-up file,
  mode `0600`; Typora then found no valid licence and wrote an empty one over
  the live file, which `data/reset` would put back.
- A witness through `start_build_computer` failed agentenv's first-boot
  probe (`P4 a click in frame space hits its cell`), also for a bundle of the
  same capture exported without withholding, so no stage ran.

## Limits of this verification

- Only a masked field was used: a field that shows its text shows a typed
  secret in screenshots and in the recording.
- A deploy refused for want of a variable leaves agentenv's build of that
  bundle failed; a later run needs `agent-env env build` or a fresh copy of
  the bundle.
- The person's consent was relayed in a test; no person was asked.
