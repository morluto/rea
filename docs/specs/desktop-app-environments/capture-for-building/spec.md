# Capture for building

## Outcome

REA's capture, state view, task draft and export fit a build in which an
agent drives the application inside an agentenv computer, makes the seed and
then the change in one capture, and exports a bundle that can be shared. The
seed is the state at a checkpoint the agent names rather than the state before
launch; the capture finds the package's sources from lists an ordinary user
downloaded; the application does not inherit the computer's control token;
and the bundle holds neither the capture host's name nor its user's.

## Requirements

- Checkpoints: the export takes `--seed-checkpoint` and `--end-checkpoint`,
  and the task draft the same two options. The seed checkpoint chooses the
  seed files, their text formats, the unseeded files and the dconf keys; the
  end checkpoint is where a task's checks must all pass, the seed where at
  least one must fail; the draft compares the two. A file's state at a
  checkpoint is its last version recorded at or before it. Without the
  options they are the baseline and the capture's last checkpoint, so earlier
  captures export and draft as before. A name the capture does not hold
  exactly once, and an end before the seed, are refused naming the option.
  The export reports both names in `checkpoints`, and the draft in its own
  `checkpoints` as `baseline` and `final`.
- apt folders: the lists folder, the trusted parts folder and the trusted
  keyring are where `apt-config shell` resolves `Dir::State::Lists/d`,
  `Dir::Etc::TrustedParts/d` and `Dir::Etc::Trusted/f`, so an `APT_CONFIG`
  file that moves them is followed; each is apt's default when `apt-config` is
  missing, fails or names no absolute path.
- Launch environment: the application gets REA's environment without any
  variable whose name starts with `AGENTENV_`, plus the run token.
- Host identity: the capture records `host.hostname` and `host.user`, each
  optional, so captures written before parse; one is left out when the system
  cannot say.
- Scrub: the export replaces `user@host` with `user@localhost`, the host name
  as a whole name with `localhost`, and the captured home where a whole path
  segment ends after it with `/home/user`, in seeded text files read as
  UTF-8, in UTF-16 seeds with a byte-order mark, and in the dconf keys. A
  host named `localhost` keeps that name, but its captured `user@localhost`
  is still replaced. The user name alone is never replaced. JSON is scrubbed
  by its string values, decoded, never its member names, and XML by its
  decoded character data and attribute values, plus comments and CDATA, so
  neither's syntax or names change and escapes hide nothing; a UTF-16 seed is
  scrubbed by the format its text would have in UTF-8. dconf keys are
  scrubbed by their decoded GVariant strings, never group names, keys,
  dictionary keys or other values, and a value that does not parse or holds
  an object path or signature ships as captured. A rewritten seed is a
  generated file with its own SHA-256. The class's `SEED_HOME` is `/home/user`, which it respells
  to the computer's home at boot as before. A capture whose home is already
  `/home/user`, as inside a computer, has no home to replace. A capture
  without the host's name and user has only its home replaced, with a
  limitation.
- Leftovers: every shipped file, generated ones included, is searched in its
  path and content, escapes decoded, for the host name and `user@host`
  anywhere and the captured home as a whole path, with the replacements set
  aside. `scrubbed_files` lists the rewritten seeds and `unscrubbed_files`
  every file found, by bundle path; the README lists both. gzip seeds
  compressed again only to clear their headers, their documents unchanged,
  are in `recompressed_files` instead, which the README counts.
- Tasks: checks whose values name `user@host` or the host name by that rule
  are refused, like those that name the captured home, but not for their
  field names, kind or id; and the checks that must fail on the seed are
  evaluated on the seed as the bundle ships it. A value check is refused as
  pointing into text only when its file is text at the seed or the end
  checkpoint, so versions before or after them do not count.

## Non-goals

- No MCP tools, no build computer, no control channel with acknowledgements
  and no witness; later steps own those.
- No change to captured Evidence or the state view's views: they keep the
  captured bytes, and only the bundle is scrubbed.
- No rewriting of binary files, SQLite databases or file names, and no
  replacement of the user name standing alone.
- No change to the draft's field names, `baseline` and `final`.
