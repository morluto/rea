# Desktop application export

`rea export-desktop-application <capture-folder> <directory>` turns a folder
written by [desktop application capture](desktop-application-capture.md) into an
agentenv bundle holding one computer app environment: the real application,
installed from the distribution archive on the `ubuntu-24.04` computer base,
launched at boot, seeded with the user's state and serving that state through
agentenv's data operations.

```sh
rea export-desktop-application ./mousepad-capture ./mousepad-bundle
agent-env run ./mousepad-bundle --dry-run
```

The export reads the capture and its [state view](desktop-application-state.md);
it does not run the application. `--name` sets the environment name; otherwise
it comes from the desktop entry id or the program. The output directory must be
new or empty.

## The bundle

| Path                    | Contents                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `envs/<name>/env.toml`  | `type = "computer_app"`, the module and class, `computer = "ubuntu-24.04"`, `driver = "reference"` |
| `envs/<name>/<name>.py` | The `ComputerAppEnvironment` class                                                                 |
| `envs/<name>/SKILL.md`  | What the app is, its window class and where its files live                                         |
| `envs/<name>/seed/`     | The application's files from before the capture, by home-relative path                             |
| `tasks/smoke.json`      | A task that deploys the app                                                                        |
| `README.md`             | What was exported, from which capture, and what to keep in mind                                    |

The class declares:

- `Packages(apt=[...])` with the package the capture found. The export refuses
  applications not installed from a package archive (local `.deb`, snap,
  flatpak, AppImage), since the computer could not install them.
- A launch at boot with the captured command, ready when a window of the
  captured class appears. Arguments under the captured home are respelled under
  the computer user's `$HOME`. The export refuses a capture that saw no
  application window.
- `paths`: the state directories holding the application's state files and the
  folders holding its documents, nested folders collapsed.
- Data hooks, because declaring any hook switches off agentenv's default data
  plane: the class seeds the home once per boot and keeps it as the initial
  state with `keep_initial`, `data/add` and `data/reset` call agentenv's `add`
  and `reset`, and `data/get` returns the files under `paths` plus a data part
  with a typed JSON view of each (SQLite rows, JSON, XML, key file groups or
  text lines). An application with no observed state declares no paths and no
  hooks.

Seeded text files have the captured home path respelled to the computer's
home. The application's dconf keys at the baseline, if any, are loaded once
with `dconf load /`; `data/reset` does not restore them.

The seed is the user's real data. Keep the bundle local and do not publish it.
The class was checked against agentenv-framework 0.9.1431 with
`python -m agentenv_protocol.computer._declare` and `agent-env run --dry-run`.
