# Secrets typed unseen

## Outcome

An agent building an environment for an app that asks for a password, a
licence key or a sign-in types it through REA without seeing it. The person
keeps the secret in a file on the build host; the agent names it by a handle;
REA types its value into the build computer. No tool result, action log,
witness record or exported bundle holds the value, and an export refuses a
bundle that does.

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
  `<secret:<handle>>`. Images pass as they are.
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
  the folder.
- The skill asks the person for a secret's file instead of the secret, types
  it only into a masked field, and stops when an export finds a secret.

## Non-goals

- Redacting images: screenshots and the witness's recording show whatever
  the screen shows, so a secret stays unseen only in a field that masks it.
- Finding a value inside a zip archive's compressed entries, or a token an
  app derives from a secret, such as a session token after a sign-in.
- Keeping the secrets folder from the building agent's own shell on the same
  host; the client's permission rules do that.
- Accepting a licence, recording consent, leaving an app's sign-in or licence
  state out of the seed, and secrets a bundle's receiver supplies at run
  time: those come next.
