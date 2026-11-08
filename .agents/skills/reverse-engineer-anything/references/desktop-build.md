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
- When the app exits at launch for want of a runtime piece its package does
  not install, start a new build computer with that package in
  `extra_packages`, up to 16 archive names; the export installs them too.
  MyPaint needs
  `{"kind": "archive", "package": "mypaint", "extra_packages": ["librsvg2-common"]}`
  for its SVG icons, and Freeplane `["openjdk-17-jre"]`, since its launcher
  refuses noble's Java 21. Name one up front, too, when a package the app
  only recommends holds its content, such as QElectroTech's element library
  `qelectrotech-data`, without which no component can be placed.
- Take the `.deb` path only when the app is not in the archive at all, not
  to add a package. Ask the requester for its URL and SHA-256; do not fetch
  a vendor's download page yourself. List its `Depends` as `dependencies`,
  with any runtime piece it lacks: it installs with the network off.
- Flatpak, AppImage and snaps are not supported yet: say so and stop. An
  archive package that only installs a snap, such as noble's `firefox`,
  counts as a snap. A package with no build for this host's architecture
  (some PPAs are amd64 only) cannot be installed either.
- `desktop_entry` is the package's `.desktop` file name under
  `/usr/share/applications` without `.desktop`, such as
  `org.inkscape.Inkscape`. Add `window_class` when you know it; Inkscape's
  is `Inkscape`. AbiWord's entry is `abiword` and its class `Abiword`.
- To find the entry, read the package's file list: its page on
  packages.ubuntu.com, or `apt-get download PKG && dpkg -c PKG_*.deb` where
  apt runs. The entry may ship in a companion `-data` or `-common` package,
  as Planner's in `planner-data`: read that package's list too. The entry's `StartupWMClass` may not be the window's real
  class, so do not take `window_class` from it: MuseScore 3's says
  `mscore3`, its window's is `MuseScore3`. The export uses the class the
  capture saw.

## Drive the app

- Pass `computer_id` and the action's fields at the top level: click
  `{x, y, count}`, scroll `{x, y, direction, amount}`, a screenshot region
  `[x0, y0, x1, y1]`. The rest are in
  [the build-computer guide](https://github.com/morluto/rea/blob/main/docs/desktop-build-computer.md).
- Take a `screenshot` before pointing: points are pixels of the latest
  frame. If a response is too large, ask for a `region`, or `jpeg` with a
  lower `quality`. A screenshot with `region` does not capture the screen
  again; it crops the latest frame, so take a full screenshot, or a `wait`
  with `screenshot: true`, first. The crop then becomes the latest frame:
  take a full screenshot before pointing again.
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
  `{"action": "key", "keys": ["Control", "s"]}`, and `type` turns `\n` into
  Enter.
- Before `type`, check in a screenshot that a text cursor or a focused
  field is there. In apps with single-key shortcuts, such as Inkscape, text
  typed without one runs as commands.
- Save As differs by app. Check the dialog's current folder first: most
  open in the home, so click Documents in the sidebar, but Scribus opens in
  `~/Documents` and its sidebar has no Documents entry. Type only the file
  name. A dialog taller than the 1280×800 screen hides its buttons:
  maximize it from its title bar, or confirm it with `key` Return, as when
  HomeBank's Save button is off-screen. When a GTK Save dialog ignores
  clicks or runs off the screen, type `~/Documents/<name>` in its Name field
  and press Return.
- Answer the app's save questions, such as keeping the format, then check
  the saved path in the title or status bar, or the dialog's folder when
  the app shows only the name, and that it shows no unsaved mark, before
  you mark a checkpoint or check. Where the title never shows one, as in
  HomeBank, a greyed Save or Revert, or the file reopened from recent
  files, confirms the save.
- Qt spin boxes change their value on scroll: move the pointer off them
  before you scroll.
- gLabels edits an object's text in Object properties → Text, not on the
  canvas.
- In Grisbi's transaction form Return moves to the next field; only Return
  in the last field, Notes, records the transaction.
- ghostwriter autosaves a new document as `~/Documents/untitled-1.md`: name
  it with File → Rename, not Save As; Ctrl+Shift+S does nothing, and Enter
  after a checklist item starts another `- [ ]` item.
- KMyMoney's first launch opens the New File Setup wizard; Finish asks for a
  storage type (XML), then a Save As where typing `Documents/<name>.kmy`
  works. Its date field is a sectioned Qt editor: double-click the month and
  type each part, since Ctrl+A garbles it. A new transaction's payee comes
  prefilled and selected. Amounts are saved as reduced fractions, such as
  `-1749/20`, so compare them exactly. Untick Help → Tip of the Day → "Show
  tips on startup" before `seed`, or the tip appears at every boot.
- QElectroTech: an element dropped from Collections follows the pointer until
  a click on the folio places it. Its title shows only the app, so it needs
  `state_paths`; its settings are in `~/.qet`.
- Rosegarden: after a dialog its Transport window can take keyboard focus,
  so save with File → Save.
- Pencil2D: the Tools dock is too narrow for its buttons, so use shortcuts
  (B for the brush); double-click a layer's name to rename it.
- Umbrello: the title shows no unsaved mark, so confirm a save with a probe
  checkpoint. An Untitled document autosaves `~/autosave.xmi`: delete it
  before `seed`. Add attributes from the tree: right-click the class → New →
  Attribute.
- Hydrogen: the computer has no audio device, so Hydrogen falls back to a
  null driver and its BPM field snaps back to 120 within about 100 ms.
  Before `seed`, set Preferences → Audio System → ALSA with device `null`
  and click "Apply and restart output", which `~/.hydrogen/hydrogen.conf`
  keeps for the seed; also set autosaves per hour to 0, and dismiss the
  development-version dialog with "Don't show again". `pulseaudio` as an
  extra package does not help.
- Poedit cannot add entries by hand. Use File → New, pick the language and
  save to `Documents` first (Sources Paths stays locked until then), then
  Properties → Sources Paths → + → Add Files with a source such as
  `/usr/lib/python3.12/argparse.py`. It writes `fr.mo` beside the `.po`, and
  the language box's autocomplete popup takes the first OK click.
- CherryTree: its first-run autosave "Choose Storage Type" dialog swallows
  keys, so save once early as `.ctd` and untick autosave.
- Glade: a new widget's id is empty until you set it, and a second save
  writes a `.glade~` backup.
- VYM: the title never names the map, so pass `Documents/<map>.vym` in
  `state_paths`. Its settings live in `.config/InSilmaril` and are written
  only at a clean exit. It writes `<map>.vym.lock` while a map is open, so
  close the map before `seed`. Press A only after clicking a branch on the
  canvas: keys typed in the tree editor run other shortcuts.
- Sigil unpacks the open book into
  `.local/share/sigil-ebook/sigil/workspace/Sigil-XXXXXX/` and deletes it on
  exit; naming the whole `sigil-ebook` folder seeds that stale copy, so name
  only the book, and its settings files if needed.
- What the app saved under the home before `seed`, such as a document in
  `~/Documents` or its settings, is part of the seed. A file you move to the
  Trash is left out, and the export lists it in `limitations`. Trash a stray
  file rather than starting over. JabRef 3.8 writes `<file>.bak` and
  `<file>.sav` beside a `.bib` it saves; in the owned folder they are seeded
  and show in the draft as noise, so trash them before `seed` if they should
  not ship.
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
   The first start of an app builds its image, and starts at the same time
   on this host wait for each other; either can take minutes. A failed
   start returns the build's error: fix the request, or stop when the
   install cannot work, and close any `computer_id` the error names.
2. `start_build_capture`. It returns once the app's window is open. A
   `package_lists_error` may stop the capture finding the package's
   sources; the export says when that matters. When the app exits before
   its window opens, the error gives its exit code and the end of its
   stderr, which may name what it lacks, such as an icon loader or a Java
   runtime: close the computer and start a new one with that package in
   `extra_packages` (see Choose the install), or stop as for an install
   this flow cannot do.
   - REA counts a file as the app's document only when the app's window
     title shows its file name or `~/` path. When the title shows something
     else, such as MuseScore's score title, pass the path you will save the
     document at in `state_paths`, relative to the home:
     `{"computer_id": ..., "state_paths": ["Documents/MuseScore3/Scores/Morning_Song.mscz"]}`.
     It need not exist yet. Add the app's settings folder when its name
     differs from the app's, such as `.config/MuseScore`, so the seed keeps
     the dismissed first-run dialogs. Do not pass the document as a launch
     argument to make REA see it: `state_paths` is the way. gLabels' title
     leaves out the file's extension and Grisbi's shows the entity's name,
     so both need it.
   - An app whose document is a folder of pages, such as a Zim notebook
     (`Notebooks/Notes`, a `.txt` file per page), never shows a file in its
     title: pass the folder in `state_paths`. Every page in it is then a
     document, so the bundle opens none at launch and the app starts where
     it keeps its place; check the page the task changes.
3. Make the seed through the app and save it from the app under
   `~/Documents`: build the document in the app, or write its source where
   the app edits its format as text, then save it again from the app. Make
   it look real but synthetic: the thing the task changes, plus a few things
   the change must leave alone. Keep it to one document: the bundle's app
   opens the seed's document at launch only when there is exactly one, and
   otherwise starts on its own screen. For a starting file of the requester's,
   read it here and rebuild it in the app with synthetic data in place of
   personal data; REA cannot copy a file into the computer.
   - An app that keeps its own data and saves after every change, such as
     Osmo's contacts in `~/.local/share/osmo/contacts_records.xml`, has no
     document: that state is the seed. Build it in the app and mark `seed`
     once the app has written. To see whether it has, mark a throwaway
     checkpoint, such as `probe-1`, and read its `changed_files`: up to ten
     files that changed since the checkpoint before, those a window title
     named first, then those under `state_paths` and those the app held
     open, caches last, with `more_changed_files` counting the rest.
   - The app's own compressed format works when it is gzip, such as
     Gnumeric's `.gnumeric`, Dia's `.dia` or Inkscape's `.svgz`: REA reads
     the document inside, and checks point into it as into the same
     document uncompressed. A format REA reads as binary, such as one
     compressed with xz, has no view: save in a format the app offers that
     REA reads, then reopen the file once and check that a plain Ctrl+S
     keeps that format.
4. Only once the seed is saved, `mark_build_checkpoint` with name `seed`.
5. Make the change the task asks for, as a user would, and save it.
6. Only once the change is saved, `mark_build_checkpoint` with name `end`.
7. `stop_build_capture`. Read `draft.files` (each file that changed, with
   its net change and its `values`), `draft.task.checks` (suggested
   checks), `draft.guards`, `draft.notes` and `limitations`. When `draft`
   is null, read `draft_refusal` first: a missing `seed` or `end`
   checkpoint means capturing again on a new build computer, while a failed
   draft command names its own cause to fix. When `draft.files` is empty,
   `draft.notes` says why:
   - `no_change`: nothing was saved between `seed` and `end`. Capture again
     on a new build computer, and save before marking `end`.
   - `unowned_changes` with `no_document`: the app saved your document
     where REA did not count it as the app's. Its `files` list what changed,
     with their roles; the document is among them. Close the computer and
     capture again on a new one with that path in `state_paths`; the export
     refuses a check on a file outside the owned paths.
   - `uncheckable_changes`: the app saved the change in dconf, as gedit does
     its preferences, and no check reads dconf. Saving again does not help:
     choose a change the app saves in a file, and capture again on a new
     build computer.
   - `unreadable_changes`: a dconf database changed but REA could not read
     it; `error` says why. This is not evidence the app saved there: report
     the error rather than changing the task.

   A note with a `file` says why that file's suggestions are thin:
   - `by_position`: only position names what changed; its `elements` lack
     a naming attribute. Name a record that keeps its fields as child
     elements by one of them, as Osmo's contact by
     `[name=contact][>first_name=Delphine]`, and count records with
     `member_count`, `matching` `[name=contact]`; otherwise check an
     ancestor's text, or give the element an id in the app and capture again.
   - `view_state_only`: every change is view state, a renumbered id or a
     time the app stamps, and its `pointers` are the checks kept. The edit
     was likely not saved: capture again and save it before `end`.
   - `long_text`: the element's text is too long to check whole; check a
     phrase in it with `text_contains`.
   - `cut_view` or `unreadable_view`: REA's view holds only part of the
     file, or none a check can read, such as a binary format (step 3).

## Write the task

Write `{"name", "prompt", "checks"}` from the draft and what you did.

- `name`: lowercase letters, digits and hyphens, not `smoke`.
- `prompt`: what the requester wants, in their words and the app's terms,
  starting with the app's name, naming the document as a user would and
  ending with saving it: "In Inkscape, change the poster's headline in
  Documents/poster.svg to Summer Bake Sale and save it." Name the app: the
  solving agent's own shell cannot see the computer's files, and the app's
  name sends it to the screen. Leave saving out for an app that saves on its own, after every change
  or a few seconds after the last one, such as Osmo or Gnote: grading waits
  until the app's files have held for 3 s, so the solving agent need not
  wait for the save. A save more than 3 s after the agent stops is still
  missed; name such an app in the report. Never say how the file stores it,
  and never give the checks.
- Checks are file-based: content checks that prove the edit, never only that
  a file exists or changed. Start from the suggestions; keep those that say
  what the user did and drop what follows from how the app saves.
- Compare exact values, so a typo or a wrong number fails.
- Read each file's `values` before writing checks: every value the change
  added, changed and removed, with `before` and `after` (an uncut scalar, or
  a preview cut at 600 characters) at the pointer a check names it by. Copy
  the pointer. Copy `after` into `value` only when it is an uncut scalar: a
  string without a trailing `…`, a number, or a boolean. Compact XML and a
  JSON array or object are preview strings, so a `value_equals` check needs
  the structured value from the file's view, and element text uses
  `text_equals` or `text_contains`.
  Only XML files, archives, JSON and key files have values: a text file's
  or SQLite database's `change` already lists its lines and rows.
  `refers_to` says what a number stands for, such as `category="44"`
  naming `<cat key="44" name="Groceries"/>`; use it for the prompt's words.
  Skip entries whose `note` is `by_position` (no check can use that
  pointer) or noise (`view_state`, `renumbered`, `volatile`,
  `timestamp`, `upkeep`). `values_cut` means a limit left some out.
- Select elements by what they hold, never by position: SVG text by id,
  `/root/children/[name=g][@inkscape:label=Layer 1]/children/[name=text][@id=headline]/children/[name=tspan]/children/0`,
  or an ODF paragraph by style,
  `/entries/[name=content.xml]/view/root/children/[name=office:body]/children/[name=office:text]/children/[name=text:p][@text:style-name=Title]/children/0`.
  A selector must match exactly one element, so give the target a unique id
  or style in the seed. The draft's pointers already do this: a name-like
  attribute such as Scribus's `ANNAME` before a coordinate, and two
  attributes together where one is not enough, as a spreadsheet cell's
  `[@Col=3][@Row=2]`. Only an element's text is read by position, as
  `children/0`.
- When an app may split an element's text into runs, check it whole:
  `text_equals` (or `text_contains` for a value inside a sentence) on the
  element compares all its text, however it is split. Add
  `normalize_whitespace: true` when the app may reflow spaces. Example, an
  AbiWord paragraph by its stable id:
  `{"kind": "text_contains", "file": "Documents/memo.abw", "pointer": "/root/children/[name=section]/children/[name=p][@xid=6]", "value": "at 3:30 PM"}`.
  Point a text check at the paragraph or another element the edit keeps,
  never at a run such as AbiWord's `[name=c]`: a reopened document splits
  the text into several runs. The draft lists only what changed; an
  unchanged element is in `draft.guards` when it is a like sibling of a
  changed one, and otherwise use the app's usual numbering, such as another
  paragraph's `xid`, and let the export confirm it.
- In an ODS spreadsheet no attribute names a row or a cell. Name the sheet
  in the seed, and check its whole text: `text_equals` on
  `/entries/[name=content.xml]/view/root/children/[name=office:body]/children/[name=office:spreadsheet]/children/[name=table:table][@table:name=Q1 Sales]`,
  or a stretch of it with `text_contains`. Cell texts join with nothing
  between, so a row reads `February23100`.
- For a line added to free text, such as an item on a note's list, the
  draft suggests `text_contains` of the new line, which passes however the
  app spaces or orders it, and a guard that the old text is still there.
- Some apps keep text in an attribute, one element per run, such as
  Scribus's `<ITEXT CH=...>`: add `"text_attribute": "CH"` to `text_equals`
  or `text_contains` on the frame,
  `/root/children/[name=DOCUMENT]/children/[name=PAGEOBJECT][@ANNAME=Headline]`,
  to read its runs' values joined.
- When the draft shows no values or no checks, a scratch export can expose
  `envs/<env>/seed/` only after the task has at least one valid check: it must
  pass on the captured end state and fail on the seed. Before the first
  successful export, use `act_on_build_computer` to open the saved file in an
  available GUI text editor or viewer and inspect its actual representation
  without changing it. Use the visible saved content and the task's edit to
  write a check; an export refusal can also name the end state's value, such
  as `is "44", not "1"`. If the file cannot be inspected or expressed by a
  supported check, report the limitation instead of guessing a check.
- Where easy, add one check that the rest is untouched, such as another
  text's value the edit must leave alone. `draft.guards` offers them at
  their seed values, which the end holds too: a field on the nearest like
  siblings, one the user sets, such as Planner's `work`, before a default
  they all share; the text an addition kept; a text file's lines beside its
  new one. Copy one or two into `checks`; they pass on the seed, which is
  fine, since the export needs only one check to fail there.
- The draft suggests a decimal the app writes as text, such as `146.83`,
  as a number with `tolerance: 0.001`; keep the tolerance for any number
  you check that way.
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

The limitations name the folders the app wrote that the bundle neither owns
nor seeds, such as `~/.config/MuseScore`, so the app starts without them:
expect its first-run wizard, a tour or a "restore session?" question at every
boot. If the witness shows one, capture again on a new build computer with
those folders in `state_paths`, and dismiss the dialogs before `seed`. Lock
files the app holds while it runs, such as LibreOffice's `.lock` and
`.~lock.<name>#`, GnuCash's `<book>.LCK` or Grisbi's `.<file>.lock`, are
left out of the seed and listed after "Left out of the seed". An app can
still start fine yet refuse every save when a lock was seeded, so close the
document before `seed` where the app lets you (apps other than LibreOffice,
such as Rosegarden, also write `.~lock.<name>#` and autosaves beside a
document, and closing it covers them too), and treat "file is locked"
on a save in the witness as a seeded lock: delete it from the bundle's seed
and witness again in a new computer. In LibreOffice, own the profile
(`state_paths: [".config/libreoffice"]`) for a clean boot, and close the
document before `seed`, then reopen it from Recent Documents to make the
change: the export also leaves out the recovery list LibreOffice writes while
a document is open, which would start the bundle into document recovery. A
limitation naming `~/.config/dconf/user` as unread means the app's dconf
settings, such as a first-run tip you turned off, are not seeded: capture
again on a new build computer. The limitations also name seeded WebKit,
Chromium or QtWebEngine storage and caches; when the witness's boot is clean,
list them in the report.

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
   desktop may not have drawn yet. When the start fails because the
   computer never got ready, and its error names lock files in the bundle's
   seed, delete them from the bundle and start again.
2. `check_build_task` with `stage: "seed"` and `directory`, the absolute
   path of a new or empty folder for the record. A check must fail.
   Recording starts. Later stages take no `directory`.
3. Do the task from the prompt with `act_on_build_computer` and save.
   `check_build_task` with `stage: "after_edit"`: every check must pass.
   Each check waits until the app's files have held for 3 s, as the
   bundle's verifier does, so an app that saves on its own needs no wait of
   yours. A result with `settled: false` means the files were still
   changing at the 15 s bound, and `read_cut: true` that a slow read was
   still running there.
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
  the host or user, so it needs review before sharing. `recompressed_files`
  are gzip seeds whose headers were cleared, their content unchanged: give
  their count;
- limitations: the capture's, the export's and anything you could not do;
- solver runs, if any: the model, the runs and the passes;
- the build time and the questions you asked.

Never publish or share the bundle yourself.
