# Secrets typed unseen

## Outcome

An agent building an environment for an app that asks for a password, a
licence key or a sign-in types it through REA without seeing it. The person
keeps the secret in a file on the build host; the agent names it by a handle;
REA types its value into the build computer. No tool result, action log,
witness record or exported bundle holds the value, and an export refuses a
bundle that does. The sign-in or licence state the app writes is withheld
from the bundle and supplied by whoever runs it, unless the person consents
to seed it. REA does not infer secrecy from a value or name.

## Requirements

- Secret files: one per handle, in `$XDG_CONFIG_HOME/rea/build-secrets/`, or
  `~/.config/rea/build-secrets/` when `XDG_CONFIG_HOME` is unset or relative,
  as the REA server's environment gives them. A handle is
  `^[a-z0-9][a-z0-9._-]{0,62}$`. REA reads a handle's file when it types it
  and refuses it unless the folder is a real folder, not a symbolic link, and
  the file is a regular file, opened without following a link and without
  blocking, owned by the server's user, with no group or other permission
  bit, of at most one secret's size, and UTF-8. Its text, without one final
  `\n` or `\r\n`, must hold 8 to 1024 characters and no control character.
  A refusal names the file and the reason, never its text.
- `act_on_build_computer` action `type_secret`, taking only `secret`, a
  handle, and refusing `screenshot`, `text` or any other field, and its
  absence: REA sends `computer_type` with the value as `text`. Its result is
  REA's own: `summary` `Typed the secret <handle>` and the driver's
  `applied`, `delivery` and `others_since_frame`, one text block saying the
  same, and no image. A driver refusal, or a call that fails, is REA's own
  error naming the handle, without the driver's words or the cause, since
  either could quote the value; a cancelled call stays a cancellation.
- Action log: a `type_secret` entry records `{"secret": "<handle>"}` and
  counts as an input for the witness's edit and near miss, as `type` does.
  Every string the log keeps, member names included, has each secret typed
  on the server replaced by `<secret:<handle>>`.
- Results and records: every string in each build tool's text content and
  structured content, errors included, and in `witness.json`'s record, has
  each secret typed on the server, in each text spelling below, replaced by
  `<secret:<handle>>`. Images pass as they are. So has the start of one that
  a cut of REA's own leaves before its `…`: a draft value or the element it
  refers to cut at 600 UTF-16 code units, a string of a draft's view at
  2,000, and a value's JSON a check's description quotes at 200; other text
  ending in `…` is left as it is. The host redacts the app's stderr and the
  capture's progress before it quotes their end.
- Export scan: before writing a bundle on the host, REA searches each file's
  path and bytes for every secret typed on the server and every other one the
  folder holds, whatever its permissions, in these spellings: as it is,
  escaped in JSON, UTF-16LE and UTF-16BE, lower- and upper-case hex of its
  UTF-8, base64 in either alphabet of the characters that depend on the
  value alone at each of the three byte alignments, and URL-encoded with
  upper- or lower-case escapes and with `+` for a space; and the same inside
  a gzip file, decompressed up to 64 MiB. A bundle holding one is refused as
  an invalid request naming each secret's handle and the files, each value
  in a file's name shown as `<secret:<handle>>`, and nothing is written to
  the folder. A gzip file that expands past 64 MiB, which the scan cannot see inside, is refused by name when known secrets are checked.
- The skill asks the person for a secret's file instead of the secret, types
  it only into a masked field, and stops when an export finds a secret.
- Withheld state: files under the owned paths that changed after checkpoint
  `pre-sign-in` up to `post-sign-in`, by the capture's recorded changes, and
  those `withhold` names, are withheld. With only one of the two checkpoints
  the export is refused, and so is a window in which a walk, from
  `pre-sign-in` to `post-sign-in`, stopped at its entry limit, could not list
  a directory or check a path, or left a change unconfirmed, since it may
  have missed a file the sign-in wrote. The draft leaves the withheld files
  out and lists them as `withheld_files`; a task check naming one is
  refused. An export is refused, too, for a dconf key of the app that the
  window changed and the seed holds other than before it, since the class
  seeds dconf keys and cannot withhold them, unless the withheld state is
  seeded with consent. Each withheld file present at
  the seed is left out of it and becomes a `SecretStr` field of the class's
  `Settings`, named as Python takes an argument and distinct within the app,
  which `env.toml`'s `[settings]` sets to `env:REA_<APP>_<FILE>`, so a
  deploy without the variable is refused with its name. At first boot,
  before `keep_initial`, the class writes each from its setting, the file's
  bytes in base64, mode `0600`; `data/get` serves it neither as a part nor in
  the views, and `data/reset` restores it. The README names each variable and
  how to fill it. A file larger than 48 KiB is refused. The CLI copies the
  withheld files to `--withheld-copy`, outside the bundle, and the build host
  keeps each one's base64 as the secret `rea-<app>-<file>`, or the first
  `rea-<app>-<file>-<n>` holding no other value (`0600`), never replacing a
  secret file, named in the export's `withheld_files`.
- The export refuses a seed file whose bytes equal a withheld file's, by
  SHA-256, naming both files; a backup that differs from the withheld file is
  not caught, so the agent trashes backups before `seed`.
- Witness: `start_build_computer` from a bundle takes `settings`, each
  `REA_*` variable mapped to a handle, whose value, up to 64 Ki characters,
  REA puts in the deploy's environment only.
- Consent: `record_build_consent` keeps the person's words, kind `licence` or
  `seed_sign_in`, with the computer, `source: "relayed"`. The export writes
  every consent into the bundle's `consent.json`. `seed_sign_in: true` seeds
  the withheld files instead, refused unless a `seed_sign_in` consent was
  recorded; the CLI refuses `--seed-withheld` without one in `--consent`.

## Non-goals

- Redacting images: screenshots and the witness's recording show whatever
  the screen shows, so a secret stays unseen only in a field that masks it.
- Finding a value inside a zip archive's compressed entries, or a token an
  app derives from a secret, such as a session token after a sign-in.
- Keeping the secrets folder from the building agent's own shell on the same
  host; the client's permission rules do that.
- Asking the person through the client itself: the agent relays their
  words, so a consent is only as true as the agent's relay.
- Withholding state outside the owned paths, which the bundle never seeds.
