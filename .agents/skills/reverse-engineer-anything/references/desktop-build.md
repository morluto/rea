# Desktop app environments from a request

Use this when someone asks for an environment of a Linux desktop app with a
task, such as "Build me an Inkscape environment where the agent changes a
poster's headline and saves it". You are the building agent: you drive the
app on a build computer through REA's MCP tools, write the task, export the
bundle and witness it in a fresh computer. REA runs no model. The tools are
MCP-only and need Docker, `REA_AGENT_ENV_COMMAND` and
`REA_BUILD_COMPUTER_REA_ARCHIVE` where the REA server starts; when a start
reports one missing, tell the person what to set and stop.

For the whole build:

- Drive the app only with `act_on_build_computer`. Never script it, run
  commands in the computer or write its files another way.
- Ask the upfront questions once, then work on your own. Pause only when
  blocked.
- The seed's content is synthetic. Never put real personal data in it.
- Close every computer you start, on success and on failure.
- Note the time you start; the report gives the build time.

## Ask once, upfront

In one message, ask only what the request leaves open, and keep the list for
the report:

1. The app and the task, if either is unclear: what changes, in which
   document.
2. Whether they have a starting file of their own; otherwise you make one.
3. Whether they want solver runs after the witness: how many (the budget)
   and with which model.
4. If so, whether they want to review the task before those runs.

## When you are blocked

Stop, say what you need and wait only for:

- a licence the app or its installer asks someone to accept: never accept it
  yourself; name it and where to read it, and go on only once the person
  says they accept it;
- credentials: they may only be typed as handles you never see, and the
  build tools have none yet, so say the app needs a sign-in and stop. Never
  ask for a password in chat;
- a signed-in state in the seed: ask before seeding one;
- an install this flow cannot do, below.

Decide everything else yourself and note it in the report.

## Choose the install

The computer is Ubuntu 24.04 (noble) on this host's architecture only. Use
the first source that has the app:

| Source                       | `install`                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------- |
| Ubuntu archive               | `{"kind": "archive", "package": "inkscape"}`                                      |
| PPA or vendor apt repository | `{"kind": "apt_repository", "package", "uri", "suite", "components", "key_file"}` |
| `.deb` by URL                | `{"kind": "package_file", "url", "sha256", "architecture", "dependencies"}`       |

- A PPA's `uri` is `https://ppa.launchpadcontent.net/OWNER/NAME/ubuntu`,
  `suite` `noble`, `components` `["main"]`. `key_file` is the repository's
  signing key saved on this host; for a PPA, fetch it from
  keyserver.ubuntu.com by the fingerprint its Launchpad page shows.
- For a `.deb`, ask the requester for its URL and SHA-256; do not fetch a
  vendor's download page yourself. List its `Depends` as `dependencies`:
  it installs with the network off.
- Flatpak, AppImage and snaps are not supported yet: say so and stop. An
  archive package that only installs a snap, such as noble's `firefox`,
  counts as a snap. A package with no build for this host's architecture
  (some PPAs are amd64 only) cannot be installed either.
- `desktop_entry` is the package's `.desktop` file name under
  `/usr/share/applications` without `.desktop`, such as
  `org.inkscape.Inkscape`. Add `window_class` when you know it; Inkscape's
  is `Inkscape`. AbiWord's entry is `abiword` and its class `Abiword`.

## Drive the app

- Pass `computer_id` and the action's fields at the top level: click
  `{x, y, count}`, scroll `{x, y, direction, amount}`, a screenshot region
  `[x0, y0, x1, y1]`. The rest are in
  [the build-computer guide](https://github.com/morluto/rea/blob/main/docs/desktop-build-computer.md).
- Take a `screenshot` before pointing: points are pixels of the latest
  frame. If a response is too large, ask for a `region`, or `jpeg` with a
  lower `quality`. A region crops the latest frame and becomes it: take a
  full screenshot before pointing again.
- A drawn caret does not prove keyboard focus. After using a toolbar
  control, click into the document, then type a few characters and look
  before a long text.
- Confirm a dialog with `key` Return, not a trailing `\n` in `type`.
- An action's own screenshot is taken at once. After opening a menu, a
  dialog or a window, look with
  `{"action": "wait", "ms": 500, "screenshot": true}`.
- On a computer started from a request the app is not open at first, and
  `start_build_capture` opens it: never open it yourself before that. Do not
  close it while capturing; the capture ends when the app exits. When the
  app is closed at any other time, open it from Applications → Other → the
  environment's name.
- Prefer shortcuts and typing to long pointer paths: `key` takes `keys`, an
  array holding one chord's keys, such as
  `{"action": "key", "keys": ["ctrl", "s"]}`, and `type` turns `\n` into
  Enter.
- Before `type`, check in a screenshot that a text cursor or a focused
  field is there. In apps with single-key shortcuts, such as Inkscape, text
  typed without one runs as commands.
- Save As opens in the home: click Documents in its sidebar and type only
  the file name. Answer the app's save questions, such as keeping the
  format, then check the saved path in the title or status bar, or the
  dialog's folder when the app shows only the name, and that it shows no
  unsaved mark, before you mark a checkpoint or check.
- What the app saved under the home before `seed`, such as a document in
  `~/Documents` or its settings, is part of the seed. A file you move to the
  Trash is left out, and the export lists it in `limitations`. Trash a stray
  file rather than starting over.
- Dismiss first-run dialogs, such as a welcome screen, before `seed`. A
  choice the app saves only later, such as Inkscape's "show this every
  time", may not reach the seed, so expect the dialog in the witness too.
- Give what the task changes a stable name where the app has one, such as an
  id in Inkscape's Object Properties, so a check can select it.
- Expect apps to split text into runs: Writer's revision ids split an
  edited paragraph into spans and may give it an automatic style such as
  `P1`, and AbiWord wraps each insertion in `<c>`. Check such text whole
  with `text_equals` (see Write the task), and find the paragraph by
  something the edit keeps, such as AbiWord's `xid`.

## Build the seed and the edit

1. `start_build_computer` with
   `{"source": {"kind": "request", "desktop_entry": ..., "install": ...}}`.
   The first start of an app builds its image and can take minutes. A
   failed start returns the build's error: fix the request, or stop when the
   install cannot work, and close any `computer_id` the error names.
2. `start_build_capture`. It returns once the app's window is open. A
   `package_lists_error` may stop the capture finding the package's
   sources; the export says when that matters.
3. Make the seed through the app and save it from the app under
   `~/Documents`: build the document in the app, or write its source where
   the app edits its format as text, then save it again from the app. Make
   it look real but synthetic: the thing the task changes, plus a few things
   the change must leave alone. Keep it to one document: the bundle's app
   opens the seed's document at launch only when there is exactly one, and
   otherwise starts on its own screen. For a starting file of the requester's,
   read it here and rebuild it in the app with synthetic data in place of
   personal data; REA cannot copy a file into the computer.
4. Only once the seed is saved, `mark_build_checkpoint` with name `seed`.
5. Make the change the task asks for, as a user would, and save it.
6. Only once the change is saved, `mark_build_checkpoint` with name `end`.
7. `stop_build_capture`. Read `draft.files` (each file that changed, with
   its net change), `draft.task.checks` (suggested checks) and
   `limitations`. When `draft` is null, read `draft_refusal` first: a
   missing `seed` or `end` checkpoint means capturing again on a new build
   computer, while a failed draft command names its own cause to fix.

## Write the task

Write `{"name", "prompt", "checks"}` from the draft and what you did.

- `name`: lowercase letters, digits and hyphens, not `smoke`.
- `prompt`: what the requester wants, in their words and the app's terms,
  naming the document as a user would and ending with saving it: "Change the
  poster's headline in Documents/poster.svg to Summer Bake Sale and save
  it." Never say how the file stores it, and never give the checks.
- Checks are file-based: content checks that prove the edit, never only that
  a file exists or changed. Start from the suggestions; keep those that say
  what the user did and drop what follows from how the app saves.
- Compare exact values, so a typo or a wrong number fails.
- Select elements by what they hold, never by position: SVG text by id,
  `/root/children/[name=g][@inkscape:label=Layer 1]/children/[name=text][@id=headline]/children/[name=tspan]/children/0`,
  or an ODF paragraph by style,
  `/entries/[name=content.xml]/view/root/children/[name=office:body]/children/[name=office:text]/children/[name=text:p][@text:style-name=Title]/children/0`.
  A selector must match exactly one element, so give the target a unique id
  or style in the seed. The draft may suggest positional pointers; rewrite
  them. Only an element's text is read by position, as `children/0`.
- When an app may split an element's text into runs, check it whole:
  `text_equals` (or `text_contains` for a value inside a sentence) on the
  element compares all its text, however it is split. Add
  `normalize_whitespace: true` when the app may reflow spaces. Example, an
  AbiWord paragraph by its stable id:
  `{"kind": "text_contains", "file": "Documents/memo.abw", "pointer": "/root/children/[name=section]/children/[name=p][@xid=6]", "value": "at 3:30 PM"}`.
  Point a text check at the paragraph or another element the edit keeps,
  never at a run such as AbiWord's `[name=c]`: a reopened document splits
  the text into several runs. The draft lists only what changed; to name an
  unchanged element, such as another paragraph's `xid`, use the app's usual
  numbering and let the export confirm it, or read it in the exported
  bundle's `envs/<env>/seed/`.
- Where easy, add one check that the rest is untouched, such as another
  text's value the edit must leave alone. It is the one unchanged value
  worth checking; it passes on the seed too, which is fine, since the export
  needs only one check to fail there.
- Give `value_equals` a `tolerance` for a number the app writes as text.
- When the draft shows an XML document's changes as `lines`, REA read it
  as text, for example because its DOCTYPE declares entities. Selectors are
  impossible there, and `line_count` with `contains` only approximates a
  value: `3:30` also matches `13:30`. Bound it with neighbouring text and
  name the check as approximate in the report's limitations.
- Some apps save a document reloaded from disk differently from one typed
  in the same session: AbiWord wraps each new insertion in its own markup.
  Your build's end state hides this, which is why whole-text checks matter;
  expect the witness to show the real format.

The kinds and pointer rules are in
[the desktop tasks section](environments.md#pick-the-checks).

## Export

`export_build_environment` with `task` and `directory`, the absolute path of
a new or empty folder here, such as `<home>/rea-builds/poster/bundle`. The
export seeds what was saved at `seed`, replaces the computer's host name,
`user@host` and home path (a bare user name, such as AbiWord's author
`user`, stays), and checks the task against `seed` and `end`. It refuses a task
unless at least one check fails on the seed and every check passes at the
end, and says why, such as a pointer that names nothing at the end. A
check that the rest is untouched passes on the seed too, which is fine. On
a refusal, fix the task and export again, into another folder if that one
is no longer empty. Keep
`seed_files`, `scrubbed_files`, `unscrubbed_files` and `limitations` for the
report.

Keep the build computer open until the witness holds: a task fix exports
again from it.

## Witness

Witness in a fresh computer of the bundle, from the prompt, as a solving
agent would. Do not replay the build's actions or coordinates, and do not
check between stages to steer the edit: a solving agent never sees the
checks. Give every `check_build_task` the task exactly as exported.

1. `start_build_computer` with
   `{"source": {"kind": "bundle", "path": "<bundle>"}}`. The app starts
   with the seed's files in place and opens the seed's document when the
   seed holds exactly one and the app takes a file. When the export's
   `limitations` say it opens no document, open it from the prompt's path,
   as a solving agent would. Take a `wait` screenshot first, since the
   desktop may not have drawn yet.
2. `check_build_task` with `stage: "seed"` and `directory`, the absolute
   path of a new or empty folder for the record. A check must fail.
   Recording starts. Later stages take no `directory`.
3. Do the task from the prompt with `act_on_build_computer` and save.
   `check_build_task` with `stage: "after_edit"`: every check must pass.
4. Make a near miss on top of it: a plausible wrong edit, such as a typo or
   a wrong number, and save. `check_build_task` with `stage: "near_miss"`:
   a check must fail.
5. `act_on_build_computer` with `action: "reset"`, then `check_build_task`
   with `stage: "after_reset"`: a check must fail again.
6. The last stage ends the witness: `witness.record` has the verdict, the
   path of `witness.json` and the recording's segments in `directory`.
   `close_build_computer` on the witness computer.

A stage that does not hold ends the witness as `failed`. Read each check's
result and decide:

- `after_edit` failed though the saved file is right: the check is brittle.
  Fix it, export again and witness in a new computer.
- `after_edit` failed because your edit was wrong: witness again in a new
  computer; a computer is witnessed once.
- `near_miss` passed: the checks are too loose. Tighten them, export again
  and witness again.
- `after_reset` passed: the reset did not restore the seed. Report it as a
  limitation.

Stop after three witnesses and report what still fails.

## Solver runs

Only if the requester asked for them. If they wanted to review the task
first, show them its prompt and checks and wait for their approval. Then run
the bundle within the budget, one run at a time, with the runner
`REA_AGENT_ENV_COMMAND` names:
`agent-env run <bundle> --task <name> --agent claude-code --model <model>`.
Count runs reported `passed`. A run `scored below 1` is a miss; one reported
`failed` did not finish, so run it again if the budget allows instead of
counting it. Never run past the budget.

## Close and report

`close_build_computer` on every computer still open, also after a failure.
If a close fails, call it again; if it still fails, tell the requester what
is left.

Report:

- the bundle path and the environment name;
- the task's name and prompt;
- each check, and why it proves the edit and fails the near miss;
- each witness stage with its result, the verdict, and the paths of
  `witness.json` and the recording;
- the seed's contents: `seed_files` and what each holds;
- `scrubbed_files` and `unscrubbed_files`; an unscrubbed file still names
  the host or user, so it needs review before sharing;
- limitations: the capture's, the export's and anything you could not do;
- solver runs, if any: the model, the runs and the passes;
- the build time and the questions you asked.

Never publish or share the bundle yourself.
