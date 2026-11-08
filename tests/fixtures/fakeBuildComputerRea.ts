import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTestTempDirectory } from "./temporaryDirectory.js";

/**
 * A stand-in for REA inside a build computer: `capture-desktop-application`
 * reads its requests from stdin and acknowledges each as REA's capture does,
 * then publishes a prepared capture folder on stop. It prints the failure in
 * the file `FAKE_REA_CAPTURE_FAILURE` names instead of launching, and the one
 * in `FAKE_REA_MARK_FAILURE` at its first checkpoint, exiting 1 either way;
 * `FAKE_REA_APP_EXITS` names the folder it publishes at once, as when the
 * app exits before its window opens. `describe-...` and
 * `export-...` print outputs the real CLI wrote for that folder, and the
 * export copies the bundle it wrote. Each call notes its arguments, its
 * working folder and which AGENTENV_ variables and APT_CONFIG it saw.
 */
const FAKE_REA = String.raw`
import json
import os
import shutil
import sys

NOTES = os.environ["FAKE_REA_NOTES"]


def note(name, value):
    with open(os.path.join(NOTES, name), "a") as handle:
        handle.write(json.dumps(value) + "\n")


def progress(message, event=None):
    line = {"rea_progress": {"phase": "desktop_capture", "message": message}}
    if event is not None:
        line["rea_progress"]["event"] = event
    sys.stderr.write(json.dumps(line) + "\n")
    sys.stderr.flush()


def option(args, name):
    return args[args.index(name) + 1] if name in args else None


command, args = sys.argv[1], sys.argv[2:]
note("calls.jsonl", {"argv": sys.argv[1:], "cwd": os.getcwd(), "apt_config": os.environ.get("APT_CONFIG"),
                     "agentenv": sorted(name for name in os.environ if name.startswith("AGENTENV_"))})
if command == "capture-desktop-application":
    failure = os.environ.get("FAKE_REA_CAPTURE_FAILURE")
    if failure is not None:
        with open(failure) as handle:
            sys.stdout.write(handle.read())
        sys.exit(1)
    progress("Recorded checkpoint baseline.", {"kind": "checkpoint", "name": "baseline", "trigger": "baseline",
                                                "at_ms": 0, "entries": 4, "changes": 0, "retained_files": 1,
                                                "retained_bytes": 17})
    exited = os.environ.get("FAKE_REA_APP_EXITS")
    if exited is not None:
        # The app exits before its window opens, so the capture ends on its own and publishes what it saw.
        progress("Launching notes.")
        progress("Recorded checkpoint exit.", {"kind": "checkpoint", "name": "exit", "trigger": "exit", "at_ms": 1080,
                                               "entries": 4, "changes": 0, "retained_files": 0, "retained_bytes": 0})
        out = option(args, "--output")
        shutil.copytree(exited, out)
        with open(os.path.join(out, "capture.json")) as handle:
            sys.stdout.write(handle.read())
        sys.exit(0)
    progress("The application window is open.", {"kind": "window_open"})
    taken = set()
    for line in sys.stdin:
        text = line.strip()
        if text == "stop":
            break
        name = text[len("checkpoint "):].strip()
        failure = os.environ.get("FAKE_REA_MARK_FAILURE")
        if failure is not None:
            with open(failure) as handle:
                sys.stdout.write(handle.read())
            sys.exit(1)
        if name in taken:
            progress("refused", {"kind": "checkpoint_refused", "name": name,
                                 "reason": f"A checkpoint named {name} was already recorded."})
            continue
        taken.add(name)
        progress(f"Recorded checkpoint {name}.", {"kind": "checkpoint", "name": name, "trigger": "request",
                                                   "at_ms": 1000 * len(taken), "entries": 5, "changes": 1,
                                                   "retained_files": 1, "retained_bytes": 5})
    note("stopped.jsonl", {"pid": os.getpid()})
    out = option(args, "--output")
    shutil.copytree(os.environ["FAKE_REA_CAPTURE"], out)
    with open(os.path.join(out, "capture.json")) as handle:
        sys.stdout.write(handle.read())
elif command == "describe-desktop-application-task":
    with open(os.environ["FAKE_REA_DRAFT"]) as handle:
        sys.stdout.write(handle.read())
elif command == "export-desktop-application":
    if "--schema" in args:
        if os.environ.get("FAKE_REA_SCHEMA_TOKEN"):
            if os.environ["FAKE_REA_SCHEMA_TOKEN"] == "invalid":
                print("fake-control-token-0123456789abcdef")
                sys.exit(0)
            print("runtime output fake-control-token-0123456789abcdef")
            sys.exit(23)
        if os.environ.get("FAKE_REA_SCHEMA_FAILURE"):
            print("runtime cannot load its export command", file=sys.stderr)
            sys.exit(23)
        with open(os.environ["FAKE_REA_SCHEMA"]) as handle:
            schema = json.load(handle)
        if os.environ.get("FAKE_REA_OLD_EXPORT"):
            schema["options"]["properties"].pop("syntheticSeed", None)
        print(json.dumps(schema))
        sys.exit(0)
    with open(option(args, "--task")) as handle:
        note("tasks.jsonl", json.load(handle))
    exported = os.environ["FAKE_REA_EXPORT"]
    with open(exported) as handle:
        output = handle.read()
    if "code" not in json.loads(output):
        shutil.copytree(os.environ["FAKE_REA_BUNDLE"], args[1])
    sys.stdout.write(output)
    sys.exit(0 if "code" not in json.loads(output) else 1)
else:
    sys.exit(f"unexpected command {command}")
`;

/** apt-get update as an ordinary user under APT_CONFIG: one Packages list in the folder it names, before failing when FAKE_APT_PARTIAL is set. */
const FAKE_APT_GET = String.raw`
import os
import re
import sys

with open(os.environ["APT_CONFIG"]) as handle:
    conf = handle.read()
lists = re.search(r'Dir::State::Lists "([^"]+)"', conf).group(1)
code = int(os.environ.get("FAKE_APT_EXIT", "0"))
if os.environ.get("FAKE_APT_EMPTY") and 'APT::Update::Error-Mode "any"' in conf and not os.environ.get("FAKE_APT_IGNORE_ERROR_MODE"):
    print("Err:1 http://archive.ubuntu.com/ubuntu noble InRelease")
    print("E: Failed to fetch http://archive.ubuntu.com/ubuntu/dists/noble/InRelease  Temporary failure resolving 'archive.ubuntu.com'")
    sys.exit(100)
if os.environ.get("FAKE_APT_EMPTY"):
    sys.exit(0)
if code != 0 and os.environ.get("FAKE_APT_PARTIAL"):
    open(os.path.join(lists, "archive.ubuntu.com_ubuntu_dists_noble_main_binary-amd64_Packages.lz4"), "w").close()
if code != 0:
    print("Err:1 http://archive.ubuntu.com/ubuntu noble InRelease")
    print("E: Failed to fetch http://archive.ubuntu.com/ubuntu/dists/noble/InRelease  Temporary failure resolving 'archive.ubuntu.com'")
    sys.exit(code)
open(os.path.join(lists, "archive.ubuntu.com_ubuntu_dists_noble_universe_binary-amd64_Packages.lz4"), "w").close()
open(os.path.join(lists, "archive.ubuntu.com_ubuntu_dists_noble_InRelease"), "w").close()
print("Reading package lists... Done")
sys.exit(0)
`;

/** Prepared outputs of the real CLI for the fake REA to print. */
export interface FakeReaOutputs {
  readonly capture: string;
  readonly draft: string;
  readonly export: string;
  readonly bundle: string;
  readonly schema: string;
}

export interface FakeBuildComputerRea {
  readonly home: string;
  readonly bin: string;
  readonly env: Readonly<Record<string, string>>;
  notes(name: string): Promise<unknown[]>;
}

/** A computer home and REA stand-in whose capture, draft and export answer with `outputs`. */
export const fakeBuildComputerRea = async (
  outputs: FakeReaOutputs,
): Promise<FakeBuildComputerRea> => {
  const root = await createTestTempDirectory("fake-build-rea-");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const notes = join(root, "notes");
  await Promise.all([home, bin, notes].map((path) => mkdir(path)));
  const python = execFileSync(
    "python3",
    ["-c", "import sys; print(sys.executable)"],
    { encoding: "utf8" },
  ).trim();
  for (const [name, source] of [
    ["rea", FAKE_REA],
    ["apt-get", FAKE_APT_GET],
  ] as const) {
    await writeFile(join(bin, name), `#!${python}\n${source}`);
    await chmod(join(bin, name), 0o755);
  }
  return {
    home,
    bin,
    env: {
      FAKE_REA_NOTES: notes,
      FAKE_REA_CAPTURE: outputs.capture,
      FAKE_REA_DRAFT: outputs.draft,
      FAKE_REA_EXPORT: outputs.export,
      FAKE_REA_BUNDLE: outputs.bundle,
      FAKE_REA_SCHEMA: outputs.schema,
    },
    notes: async (name) => {
      const path = join(notes, name);
      try {
        await access(path);
      } catch {
        return [];
      }
      return (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);
    },
  };
};
