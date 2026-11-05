# Export a captured application as a computer app

## Outcome

`rea export-desktop-application <capture-folder> <directory>` writes an
agentenv bundle with one `computer_app` environment for the captured
application: installed from the distribution archive on the `ubuntu-24.04`
base with the `reference` driver, launched at boot and ready when its window
appears, seeded with the user's state from before the capture, and serving that
state through `data/add`, `data/get` and `data/reset`.

## Requirements

- CLI only. It reads the capture and its state view and runs nothing else.
  The output directory must be new or empty; files are written through the
  shared safe output tree.
- It refuses applications not installed from a Debian package archive, captures
  without an application window, and environment names that are not portable.
- The class declares the apt package, and the package of the program the
  desktop entry runs when another one owns it (refused when the capture found
  no source the computer can install that package from, or only repositories
  the export leaves out supply it, as library packages so supplied are left
  out; a capture whose entry runs a program no package owns is refused), the
  captured launch
  command with
  arguments under the captured home respelled under `$HOME`, an exact window
  class match with a window ready check, `paths` from the state view's roles
  (state directories of application state files, or a folder beside one that
  differs only in letter case in the files' spelling, and folders of
  documents, nested ones collapsed) and the skill file. When the seed holds
  exactly one document and the desktop entry's `Exec` takes files, the
  launch appends its path under `$HOME`; a command that names a file under
  the home already is kept, a seed with no document launches as captured,
  and otherwise the README and the limitations say why the app opens no
  document.
- With paths, it declares all three data hooks and calls agentenv's helpers:
  seed the home once per boot then `keep_initial`, `add`, `reset`, and `get`
  plus a data part holding a typed JSON view of each file. Without paths it
  declares no hooks.
- The seed is the baseline version of every state view path under `paths`,
  copied from retained content after its digest is checked; text files have the
  captured home path respelled when seeded. Baseline dconf keys of the
  application are compiled into the user's dconf database with `dconf-cli`,
  without D-Bus.
- The README and the result state the agentenv-framework release the class was
  checked against (0.9.1431), and that the seed is real user data, unless
  `--synthetic-seed` says it was made for the task.

## Non-goals

- No image build, deploy or run; verification inside a computer is the next
  step.
- No tasks beyond a deploy smoke task.
- No pinned package version, other package kinds, or redaction of the seed.
