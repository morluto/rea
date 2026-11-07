# Verification

## Tests

- `src/domain/desktop/buildSecrets.test.ts`: handles; values too short, too
  long or holding a control character; each spelling found, base64 at every
  alignment in both alphabets and a gzip file's inside included; a near miss
  and unrelated bytes not found; text and JSON redacted, member names too.
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
  writes nothing.

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

## Limits of this verification

- Only a masked field was used: a field that shows its text shows a typed
  secret in screenshots and in the recording.
- The draft showed a private key KeePassXC generated and wrote to its
  settings between `seed` and `end`; no handle names such a value, so
  neither redaction nor the export's search knows it.
