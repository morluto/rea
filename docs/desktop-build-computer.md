# Desktop build computer

A build computer is a local agentenv computer that an agent drives while it
builds a desktop app environment. Claude Code cannot attach a new MCP server
in the middle of a session, so REA keeps the computer up and forwards the
agent's computer-use actions to it through three MCP tools:

| Tool                    | What it does                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| `start_build_computer`  | Starts a computer from a request or a bundle folder; returns its id and a first screenshot |
| `act_on_build_computer` | Sends one action to the computer's driver and returns the driver's answer, images included |
| `close_build_computer`  | Tears the computer down, by agentenv's teardown or by removing its sandbox's containers    |

The tools are MCP-only, like the debugger sessions: the computer lives as long
as the REA MCP server that started it, or until it is closed. Capturing the
app, exporting its bundle and witnessing the task on such a computer are in
[Building and witnessing an environment](desktop-build-witness.md), and REA's
skill for doing all of it from a request is
[desktop builds](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/references/desktop-build.md).

## Set up a build host

On a Linux host with Node.js and Docker, from a REA
[checkout](getting-started/installation.md#run-rea-from-a-checkout):

```bash
rea setup --client claude_code --desktop-build --install-agentenv
rea doctor --provider desktop_build --client claude_code
```

Setup shows its plan and asks before it changes anything; `--dry-run` only
prints it and `--yes` approves it. It packs REA's runtime archive into
`~/.cache/rea/build-computer/rea-<version>.tar.xz` (under `$XDG_CACHE_HOME`
when set, `~/Library/Caches` on macOS), and packs again once REA's version
changes; an archive `REA_BUILD_COMPUTER_REA_ARCHIVE` already names is
recorded instead. It records `REA_AGENT_ENV_COMMAND`, `REA_DOCKER_COMMAND` and
`REA_BUILD_COMPUTER_REA_ARCHIVE` as absolute paths in that client's REA
registration, keeping a value the registration already has other than an
archive setup packed for an earlier REA version, and refreshes the skill.
`--install-agentenv` runs `uv tool install agentenv-framework==0.9.1431`
when `uv` is on `PATH`, and otherwise prints the command. Setup never
installs Docker or Node.js and never runs `sudo`. Restart the client
afterwards.

Doctor is read-only and checks, in order: a Linux amd64 or arm64 host,
Node.js, procps `ps`, the Docker CLI, a Docker daemon reachable without
`sudo`, 20 GB free where Docker keeps images, agentenv-framework 0.9.1431,
the runtime archive of this REA version, the build settings in the
registration or the environment, and the skill. Each failure names its fix.
It also reports, without counting them against `healthy`, whether a model
endpoint for solver runs is configured and which agentenv containers
earlier builds left. Pass `--json` for the full report.

When a setting is unset where the server starts, REA uses `agent-env` and
`docker` on `PATH` and the archive setup packed for this REA version. The
rest of this page is the same setup by hand.

## Requirements

- A Linux host on amd64 or arm64 with about 20 GB of free disk for the
  images agentenv builds and pulls. amd64 and arm64 hosts both build
  natively; a host builds only its own architecture.
- Node.js at the version in `.nvmrc`, installed with
  [nvm](https://github.com/nvm-sh/nvm) or from
  [nodejs.org](https://nodejs.org/en/download), and REA
  [run from a checkout](getting-started/installation.md#run-rea-from-a-checkout).
- [Docker Engine](https://docs.docker.com/engine/install/) and its
  [post-install steps](https://docs.docker.com/engine/install/linux-postinstall/):
  add yourself to the `docker` group, then log in again.
- agentenv-framework 0.9.1431, the version bundles target. Install
  [uv](https://docs.astral.sh/uv/getting-started/installation/) first, then
  run `uv tool install agentenv-framework==0.9.1431`. Set
  `REA_AGENT_ENV_COMMAND` to the absolute path of the resulting `agent-env`
  program, normally `$HOME/.local/bin/agent-env`; `command -v agent-env`
  shows the path when its install directory is on your `PATH`. Installing it
  with pip into a virtual environment instead needs `python3.12-venv` on
  stock Ubuntu. REA runs its
  helper, `bridge/agentenv/computer.py`, with that runner's Python: the
  interpreter on the program's `#!` line, or the `python3` beside it in its
  virtual environment.
- `REA_DOCKER_COMMAND`, the absolute path of the Docker CLI, lets REA remove a
  computer whose agentenv teardown was not confirmed. Without it, REA names the
  command to run instead.
- For a request, `REA_BUILD_COMPUTER_REA_ARCHIVE`: the absolute path of a tar
  archive of a runnable REA, with its production dependencies, whose one top
  folder holds `scripts/rea.mjs`. The computer runs REA from it. From a
  checkout, `npm run pack:build-computer-runtime -- /path/to/rea-prod.tar.xz`
  writes one: `npm pack`, its package folder as
  `rea-prod` with the lockfile, `npm ci --omit=dev --omit=optional`, then
  `rea-prod` as `.tar.xz`. The archive is a copy of the checkout: pack it
  again after `git pull` and a rebuild.

Set these where the MCP server starts; a shell export does not reach a server
that is already running.

## Claude Code

Without `--desktop-build`, `rea setup --client claude_code` registers REA
without these variables. Either
export them in the shell that starts `claude`, which starts REA's server with
its environment:

```bash
export REA_AGENT_ENV_COMMAND="$HOME/.local/bin/agent-env"
export REA_DOCKER_COMMAND="$(command -v docker)"
export REA_BUILD_COMPUTER_REA_ARCHIVE="$HOME/rea-runtime/rea-prod.tar.xz"
claude
```

or set them, as absolute paths, in the `env` of the `mcpServers.rea` entry
setup wrote, such as in `~/.claude.json`:

```json
{
  "mcpServers": {
    "rea": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/rea/scripts/rea.mjs", "mcp"],
      "env": {
        "REA_AGENT_ENV_COMMAND": "/home/ada/.local/bin/agent-env",
        "REA_DOCKER_COMMAND": "/usr/bin/docker",
        "REA_BUILD_COMPUTER_REA_ARCHIVE": "/home/ada/rea-runtime/rea-prod.tar.xz"
      }
    }
  }
}
```

`measure_build_task` runs solves through agentenv, which refuses them without
a model endpoint: export `LITELLM_BASE_URL` and `LITELLM_API_KEY` in the shell
that starts `claude`, whose REA server inherits them, or set `base_url` and
`api_key` under `[model]` in `.agentenv/config.toml`. REA passes them on to
agentenv and never reads the key.

Claude Code asks before each MCP tool call its permission settings do not
allow, and a build makes dozens of `act_on_build_computer` calls. You can
allow REA's tools in those settings' `permissions.allow` list:
`mcp__rea__act_on_build_computer` allows that tool, and `mcp__rea` allows all
of REA's.

A headless run, `claude -p`, ends when the skill asks its upfront questions,
and refuses the tool calls its permission settings do not allow. Put the
answers in the request: the install source when the app is not in the Ubuntu
archive, a synthetic seed or the file to start from, whether to review the
task before it is measured, and the model and budget to measure it with, or
none:

```bash
claude -p 'Build me a Gnote environment where the agent adds olive oil to the
shopping list note. Make a synthetic note. Then measure it with <model>,
at most $4 in all, without a review first.'
```

## Start a computer

From a request, REA renders a bundle in a private temporary folder: a computer
app on the `ubuntu-24.04` base with the `reference` driver that installs the
app, opens it on demand with `gtk-launch <desktop entry>` from the computer
user's home, so its open and save dialogs start there rather than in the
framework's folder for the app, and keeps no seed and no data hooks. The app is not open when the computer starts:
`start_build_capture` opens it under REA's capture. When no capture is under
way, open it from the desktop's Applications menu, where agentenv lists it
under Other by the environment's name, such as `mousepad`; that entry launches
it through the app's server. The name is the desktop entry's last part when it
is reverse-DNS (`com.github.xournalpp.xournalpp` gives `xournalpp`), or else
the whole entry without a trailing version (`glabels-3.0` gives `glabels`).

When the app is Electron, set `electron` to true. The install rewrites that
desktop entry's command with the same policy an export uses: `--no-sandbox`
immediately after the program, unless the command already has it. The
computer's container does not grant the user namespaces Chromium's sandbox
needs, and Electron exits without the flag. With the rewritten command, the
Applications menu entry can open the app.

```json
{
  "source": {
    "kind": "request",
    "desktop_entry": "org.xfce.mousepad",
    "window_class": "Mousepad",
    "install": { "kind": "archive", "package": "mousepad" }
  }
}
```

`install` takes one of:

| `kind`           | Installs                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `archive`        | `package` from the Ubuntu 24.04 archive, on amd64 and arm64, with its optional `extra_packages` beside it  |
| `apt_repository` | `package` from the repository at `uri` with `suite` and `components`, trusting the key file `key_file`     |
| `package_file`   | The `.deb` at `url`, checked against `sha256`, for one `architecture`, after its apt `dependencies` are in |
| `appimage`       | The AppImage at `url`, checked against `sha256`, for one `architecture`, extracted with its own entry      |
| `tarball`        | The archive at `url`, checked against `sha256`, for one `architecture`, with an entry running `program`    |

Build steps run with the network off, so a `.deb`'s dependencies must be
listed.

An AppImage or a tarball is downloaded by agentenv when the bundle is put,
refused unless its SHA-256 is the one named, and unpacked by a root build
step, `install-download.sh`, under `/opt/rea-apps/<desktop_entry>`; the
export writes the same step. An AppImage is extracted with its own
`--appimage-extract`, so no FUSE is needed, and the step installs the image's
own `<desktop_entry>.desktop` under `/usr/local/share/applications` with
each `Exec` program replaced by the image's `AppRun`, after any `env` prefix
and its assignments, without `TryExec`, and its icon; an image without that entry fails the build, naming the entries it
has. A tarball is read with Python's `tarfile`, since the computer has no
`xz` program, so gzip, bzip2 and xz archives work. Its `data` filter refuses
links that point outside the folder, absolute ones included, and special
files, so such an archive fails the build. Its `program` is a path
inside the archive, and REA writes the entry: `name` in the menu, or the
entry's last part, and `program` with the files it opens (`%F`). An
Electron app's command is rewritten after this step, on the entry it
installed. An image or tarball holds no Debian package, so the capture
records its package as `unknown`; the export checks instead that the
captured program lies under the folder the download unpacks to. The
downloaded file stays in the image's layer under the app's folder beside
what it unpacks, so a 721 MB AppImage that unpacks to 3.0 GB adds both. `extra_packages` names up to 16 more archive packages, by the same
name rules as `package`, for a runtime piece the app needs that its package
does not install: apt here skips Recommends, so MyPaint 2.0.1 exits at launch
without `librsvg2-common`, GTK's SVG icon loader, and Freeplane 1.7.10 needs
`openjdk-17-jre`, since its launcher refuses noble's default Java 21. The
export installs them beside the app too, as it does a `.deb`'s
`dependencies` when apt offers the `.deb`'s package; see
[build and witness](desktop-build-witness.md).

The bundle adds REA in a build-only layer: Node.js
24.22.1, downloaded per architecture and checked against its release checksum,
and REA from `REA_BUILD_COMPUTER_REA_ARCHIVE`, both unpacked into `/opt/rea` by
a root build step, with `node` and `rea` on `PATH`. It also installs
`libgtk-3-bin`, for `gtk-launch`, and `dconf-cli`, so the capture reads the
app's settings in dconf, such as GnuCash's "Show tips at startup", and the
seed keeps them. An exported bundle carries none of it but `dconf-cli`, which
it installs when it loads the app's dconf keys.

From a bundle folder, such as one `export-desktop-application` wrote, REA
starts that bundle's `tasks/smoke.json` as it is:

```json
{ "source": { "kind": "bundle", "path": "/home/ada/mousepad-bundle" } }
```

REA runs its helper with `PYTHONDONTWRITEBYTECODE=1`, which agentenv's own
import of the bundle's app class inherits, so a start leaves no `__pycache__`
in the folder and its files stay as they were shared.

REA runs the deploy with `run_bundle(keep=True, emulate=False)` on the local
sandbox provider, so only the host's own architecture is built. The first start
of a bundle builds its image and can take minutes; later starts reuse it.
agentenv makes a start wait while another agentenv run on this host writes its
bundle's ids, so starts at the same time wait for each other, several minutes
when a few run together; the progress line then says it is waiting for another
agent-env run to finish writing this bundle's ids.
While it waits, REA sends an MCP progress notification every five seconds with
agentenv's latest line, so a client that resets its request timeout on
progress keeps waiting. REA then waits until the computer's readiness checks
pass and opens one MCP session to its driver. Readiness can pass before the
desktop has drawn, so REA takes a whole-screen PNG screenshot every 500 ms
while it is one colour throughout. The retries share 10 s, each given only
what is left of it, and when that runs out REA returns the latest frame;
progress notifications continue meanwhile. Given `screenshot` with a
`region`, `format` or `quality`, REA then takes one with them, a `region`
cropping that frame rather than capturing the screen again. The result holds
`computer_id`, agentenv's `sandbox_id`, the environment name or bundle folder,
`extra_packages`, what the request named beside the app for the export to
install too (an archive install's `extra_packages` or a `.deb`'s
`dependencies`, empty otherwise), and the screenshot's frame as structured
content beside its image.

A failed start returns the last 16 KiB of the helper's stderr, where a failing
build prints its error, and its exit status; a cancelled one stops the helper,
which tears down whatever agentenv brought up. When that teardown is not
confirmed, the error's `computer_id` names what REA keeps for
`close_build_computer` to retry. Closing the server cancels starts still in
progress and waits for them before closing every computer.

## Act

`act_on_build_computer` takes `computer_id`, an `action` and the driver's own
arguments for `computer_<action>`, which REA passes through:

| `action`     | Arguments                                                               |
| ------------ | ----------------------------------------------------------------------- |
| `screenshot` | `region`, `format` (`png` or `jpeg`), `quality`                         |
| `click`      | `x`, `y`, `button`, `count` (2 double-clicks), `modifiers`              |
| `drag`       | `path` of 2 to 50 `[x, y]` points, `button`, `duration_ms`, `modifiers` |
| `scroll`     | `direction`, `x`, `y`, `amount`, `modifiers`                            |
| `type`       | `text`, where `\n` presses Enter and `\t` Tab                           |
| `key`        | `keys`, one chord pressed in order, and `repeat`                        |
| `wait`       | `ms`                                                                    |
| `reset`      | `screenshot`                                                            |

`reset` is not a driver tool: REA calls the app's `data/reset`, which restores
the bundle's seed and relaunches the app, then waits until the computer's
readiness checks pass again, sending an MCP progress notification every five
seconds while it waits. With `screenshot: true` it then takes a screenshot; if
that fails, the reset still counts as applied and its result has no `frame`
but a `screenshot_error` with the computer's message. A computer started from
a request has no data operations, so it refuses a reset.

Pointer actions also take `frame_id`, `space` and `norm_scale`, and every
action but `screenshot` takes `screenshot: true` for an image afterwards. That
image is taken at once, so after an action that opens a menu or a window, ask
for it with a `wait` of a few hundred milliseconds instead.
Points are pixels of the latest frame, so take a screenshot first; with
`space: "norm"` they are on a `0..norm_scale` grid over it. Keys are W3C names
or one character; REA translates model spellings such as `ctrl+s`, `Return`,
`esc` and `cmd` and leaves other names for the driver to judge. An argument the
action does not take is refused before anything is sent.

The result carries the driver's content unchanged, its text and images, after
REA's own JSON: `action_index` and the driver's structured result. A refusal,
such as a stale frame, is an error carrying the computer's message. A response
larger than the MCP budget is refused with how to ask for a smaller image: a
`region`, or `jpeg` with a lower `quality`. A screenshot with `region` does not
capture the screen again; it crops the latest frame, so take a full
screenshot, or a `wait` with `screenshot: true`, first. That error keeps REA's own result,
`computer_id` included, as `details.result`, since the action or start has
happened.

Actions, the capture steps and the task checks on one computer run one at a
time, in the order REA receives them; one that has to wait for the call
before it sends an MCP progress notification every five seconds meanwhile.
Different computers run side by side.

Every action is logged on the computer in order with the arguments sent, its
start and end and whether it was applied, refused or failed. The log keeps the
latest 256 actions within 256 KiB of JSON, dropping the oldest first. Each
string argument, such as `type`'s `text`, is kept to its first 1 KiB and each
list, such as `drag`'s `path`, to its first 64 items; an entry names the
arguments it cut in `truncated_arguments`, and the driver gets them whole. The
log counts every action, so it says how many it dropped, and keeps the index of
the last applied action of each kind for rules over the whole session. The log
and the computer's recording hooks (`computer-recording/v1` start and end under
REA's own request id, and the segments fetched through the driver's `data/get`
one at a time, each read within its manifest size and checked against it) are
what the witness records; they are not tools of their own. A recording larger
than a quarter of the V8 heap is refused before any segment is read.

## Close

`close_build_computer` ends REA's MCP session and closes the helper's stdin,
on which the helper runs agentenv's teardown. When agentenv confirms nothing is
left, the result says `teardown: "agentenv"`. Otherwise REA removes the
containers of that exact sandbox: agentenv runs a computer as
`agent-<sandbox id>` without a label and labels its other containers
`agentenv.sandbox=<sandbox id>`, so REA lists both with `docker ps -aq
--filter`, removes them with `docker rm -f`, and says
`teardown: "container_label"`. When neither confirms it, the error names what
is left and the computer stays listed, so closing it again retries. A close
cancels the call in progress on the computer, refuses the calls waiting for
it, and tears down once that call has ended. Closing the
MCP server closes every computer the same way, and a helper whose REA server
exits sees its stdin close and tears down.

The control token that guards the computer's framework-only routes stays in
REA: no result, error or log carries it. Code running in the computer as its
user can still read it, which is acceptable for a local build.

See the [specification](specs/desktop-app-environments/build-computer/spec.md)
for scope and verification.
