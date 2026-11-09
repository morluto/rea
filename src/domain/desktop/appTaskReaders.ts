import { z } from "zod";

import { jsonValueSchema } from "../jsonValue.js";
import { READER_TIMEOUT_S, type DesktopTaskReader } from "./appTask.js";
import { PYTHON_EXACT_JSON_NUMBER } from "./pythonExactJsonNumber.js";
import type { TaskFileView } from "./appTaskChecks.js";

/** A runner command's outcome, as computer-exec answers it or a run on this host gives it. */
export interface ReaderCommandResult {
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timed_out: boolean;
}

/** How long past a reader's own timeout its runner and the exec route may take to answer. */
export const READER_RUNNER_SLACK_S = 30;

/**
 * REA's reader runner, one source for the witness, the export and the
 * exported verifier: it runs a reader on a private copy of its file in a
 * fresh home, without the display or the computer's control token, and
 * answers with one JSON line.
 */
export const PYTHON_READER_RUNNER = String.raw`"""REA's reader runner: one task reader, an app's own headless command, run on a private copy of a file.

It joins its JSON argument chunks and prints one JSON line: {"view": ...}, {"absent": true} when the file is not there, or
{"error": ...}. The command runs in a temporary folder with a fresh home, without the desktop's display (unless the
reader asks for it), the session bus or the computer's AGENTENV_ variables, so it reads none of the user's settings,
cannot hand the file to the running app and holds no control token; it can change only its copy, which goes with the
folder. Lines it prints starting with MARKER make its view; everything else it prints is left out.
"""
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

MARKER = "REA "
PLACEHOLDER = "{file}"
OUTPUT_BYTES = 1 << 20
ANSWER_BYTES = OUTPUT_BYTES - (64 << 10)
STDERR_BYTES = 1024
#: How often the runner looks whether the reader exited, and how long it waits for its streams to close after.
POLL_S = 0.05
DRAIN_S = 2.0
MAX_LINES = 5000
MAX_SAFE_INTEGER = 2**53 - 1
LINE_BREAK = re.compile(r"\r?\n")
SESSION = ("DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY")
NEVER = ("DBUS_SESSION_BUS_ADDRESS", "SESSION_MANAGER", "XDG_RUNTIME_DIR")
FRESH = (("XDG_CONFIG_HOME", ".config"), ("XDG_DATA_HOME", ".local/share"), ("XDG_CACHE_HOME", ".cache"),
         ("XDG_STATE_HOME", ".local/state"))


${PYTHON_EXACT_JSON_NUMBER}

def _say(answer: dict) -> int:
    line = json.dumps(answer)
    if len(line) > ANSWER_BYTES:
        line = json.dumps({"error": f"the reader's view is larger than the {ANSWER_BYTES >> 10} KiB an answer holds"})
    print(line, flush=True)
    return 0


def _environment(home: str, display: bool) -> dict:
    """The session's environment without what ties a command to the session or the computer, in a fresh home."""
    kept = {name: value for name, value in os.environ.items()
            if not name.startswith("AGENTENV_") and name not in NEVER and (display or name not in SESSION)}
    if display and "XAUTHORITY" not in kept and os.path.isfile(os.path.expanduser("~/.Xauthority")):
        kept["XAUTHORITY"] = os.path.expanduser("~/.Xauthority")
    kept["HOME"] = home
    for name, folder in FRESH:
        kept[name] = os.path.join(home, folder)
    return kept


def _not_json(text: str):
    raise ValueError(f"{text} is not JSON")


def _view(output: str, lines: list) -> dict:
    if output == "lines":
        return {"view": {"format": "text", "view": {"lines": lines[:MAX_LINES], "line_count": len(lines),
                                                    "truncated": len(lines) > MAX_LINES}}}
    try:
        value = json.loads("\n".join(lines), parse_int=_exact_number, parse_float=_exact_number, parse_constant=_not_json)
    except _Inexact:
        return {"error": "a number in the reader's view cannot be read exactly, such as an integer above 2^53"}
    except (ValueError, RecursionError) as error:
        return {"error": f"the reader's marked lines are not one JSON value: {error}"}
    return {"view": {"format": "json", "view": value}}


def _tail(stderr: bytearray) -> str:
    text = bytes(stderr).decode("utf-8", "replace").strip()
    return f"; its stderr ends: {text}" if text else ""


def _drain(stream, kept: bytearray, limit: int, tail: bool, full: threading.Event) -> None:
    """Read a stream to its end holding at most limit bytes: the first, setting full past them, or the last."""
    while chunk := stream.read1(1 << 16):
        kept += chunk
        if tail:
            del kept[:-limit]
        elif len(kept) > limit:
            del kept[limit + 1:]
            full.set()


def _feed(stream, text) -> None:
    try:
        if text is not None:
            stream.write(text.encode())
        stream.close()
    except OSError:
        pass


def _run(arguments: dict, source: str, work: str) -> dict:
    # The copy has a folder of its own, so no file name meets the runner's home.
    copy = os.path.join(work, "file", arguments["name"])
    os.makedirs(os.path.dirname(copy))
    shutil.copyfile(source, copy)
    home = os.path.join(work, "home")
    os.makedirs(home)
    argv = [part.replace(PLACEHOLDER, copy) for part in arguments["argv"]]
    stdin = arguments.get("stdin")
    timeout = arguments["timeout_s"]
    try:
        process = subprocess.Popen(argv, cwd=os.path.dirname(copy), env=_environment(home, arguments.get("display") is True),
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   start_new_session=True)
    except OSError as error:
        return {"error": f"could not start {argv[0]}: {error.strerror or error}"}
    printed, stderr, full = bytearray(), bytearray(), threading.Event()
    threads = [threading.Thread(target=_drain, args=(process.stdout, printed, OUTPUT_BYTES, False, full), daemon=True),
               threading.Thread(target=_drain, args=(process.stderr, stderr, STDERR_BYTES, True, full), daemon=True),
               threading.Thread(target=_feed, args=(process.stdin, None if stdin is None else stdin.replace(PLACEHOLDER, copy)),
                                daemon=True)]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + timeout
    try:
        while process.poll() is None and not full.is_set() and time.monotonic() < deadline:
            time.sleep(POLL_S)
        timed_out = process.poll() is None and not full.is_set()
    finally:
        # The app may leave helpers running, such as a document server: end its whole session.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        process.wait()
        for thread in threads:
            thread.join(DRAIN_S)
    if full.is_set():
        return {"error": "the reader printed more than 1 MiB"}
    if timed_out:
        return {"error": f"the reader ran past its {timeout} s{_tail(stderr)}"}
    if process.returncode != 0:
        return {"error": f"the reader exited {process.returncode}{_tail(stderr)}"}
    lines = [line[len(MARKER):] for line in LINE_BREAK.split(printed.decode("utf-8", "replace")) if line.startswith(MARKER)]
    if not lines:
        return {"error": f"the reader printed no line starting with {json.dumps(MARKER)}{_tail(stderr)}"}
    return _view(arguments["output"], lines)


def main(arguments: dict) -> int:
    home = os.path.expanduser("~")
    source = arguments["path"] if os.path.isabs(arguments["path"]) else os.path.join(home, arguments["path"])
    if not os.path.isfile(source):
        return _say({"absent": True})
    # A remote caller owns this exact folder before starting the command, and
    # removes it only after the command has settled.
    lease = arguments.get("lease")
    if lease is not None:
        work = lease["path"]
        os.mkdir(work, 0o700)
        with open(work + ".owner", "x", encoding="ascii") as owner:
            owner.write(lease["token"])
        return _say(_run(arguments, source, work))
    # A caller that names a work folder removes it itself, even when this runner is killed.
    work = os.path.realpath(tempfile.mkdtemp(prefix="rea-reader-", dir=arguments.get("work")))
    try:
        return _say(_run(arguments, source, work))
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main(json.loads("".join(sys.argv[1:]))))
`;

/** Remove only the remote folder whose ownership marker matches the caller's lease. */
export const PYTHON_READER_CLEANUP = String.raw`
import json, os, shutil, sys
lease = json.loads(sys.argv[1])
path = lease["path"]
marker = path + ".owner"
if os.path.lexists(path) or os.path.lexists(marker):
    with open(marker, encoding="ascii") as owner:
        if owner.read() != lease["token"]:
            raise RuntimeError("reader folder ownership does not match")
    if os.path.lexists(path):
        shutil.rmtree(path)
    os.unlink(marker)
`;

export interface ReaderLease {
  readonly path: string;
  readonly token: string;
}

/**
 * The command that runs a reader through the runner: on `path`, or on its
 * file in the home when none is given, in a folder under `work` when given,
 * which the caller then removes.
 */
export const readerCommand = (
  reader: DesktopTaskReader,
  path: string | undefined,
  work?: string,
  lease?: ReaderLease,
): string[] => [
  "python3",
  "-I",
  "-c",
  PYTHON_READER_RUNNER,
  ...readerArgumentChunks(reader, path, work, lease),
];

/** The runner's one argument for a reader, as JSON. */
export const readerArguments = (
  reader: DesktopTaskReader,
  path: string | undefined,
  work?: string,
  lease?: ReaderLease,
): string =>
  JSON.stringify({
    id: reader.id,
    path: path ?? reader.file,
    name: reader.file.split("/").at(-1) ?? reader.file,
    argv: reader.argv,
    stdin: reader.stdin ?? null,
    output: reader.output,
    timeout_s: readerTimeout(reader),
    display: reader.display ?? false,
    ...(work === undefined ? {} : { work }),
    ...(lease === undefined ? {} : { lease }),
  });

/** Keep every argument below Linux's 128 KiB per-string limit, including four-byte UTF-8 characters. */
const readerArgumentChunks = (
  reader: DesktopTaskReader,
  path: string | undefined,
  work?: string,
  lease?: ReaderLease,
): string[] => {
  const characters = Array.from(readerArguments(reader, path, work, lease));
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += 8192)
    chunks.push(characters.slice(index, index + 8192).join(""));
  return chunks;
};

/** The seconds a reader may run. */
export const readerTimeout = (reader: DesktopTaskReader): number =>
  reader.timeout_s ?? READER_TIMEOUT_S.default;

const answerSchema = z.union([
  z.strictObject({ absent: z.literal(true) }),
  z.strictObject({ error: z.string() }),
  z.strictObject({
    view: z.union([
      z.strictObject({ format: z.literal("json"), view: jsonValueSchema }),
      z.strictObject({
        format: z.literal("text"),
        view: z.strictObject({
          lines: z.array(z.string()),
          line_count: z.int().nonnegative(),
          truncated: z.boolean(),
        }),
      }),
    ]),
  }),
]);

/**
 * The view a runner's answer gives, its last line on stdout: undefined when
 * the file is absent, a view with the reader's error when it failed. Throws
 * when the output holds no answer of the runner's.
 */
export const readerAnswerView = (stdout: string): TaskFileView | undefined => {
  const last = stdout.trim().split("\n").at(-1) ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    parsed = undefined;
  }
  const answer = answerSchema.safeParse(parsed);
  if (!answer.success)
    throw new Error(
      `REA's reader runner did not answer; it printed: ${stdout.slice(-512)}`,
    );
  const { data } = answer;
  if ("absent" in data) return undefined;
  if ("error" in data) return { format: null, view: null, error: data.error };
  return data.view;
};

/** The verifier's runs of the task's readers through the computer's computer-exec, as the witness runs them. */
export const PYTHON_READER_VIEWS = String.raw`

# Entries retain interrupted commands and their exact folders for a retry.
_PENDING_READERS = {}


def _owned_task(awaitable):
    task = asyncio.create_task(awaitable)
    task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
    return task


async def _cleanup_readers(env_url, card):
    for token, pending in list(_PENDING_READERS.items()):
        if pending["env_url"] != env_url:
            continue
        if not pending["settled"]:
            if pending["task"].cancelled():
                raise RuntimeError(f"Reader {pending['request_id']} has an unknown outcome; retained {pending['lease']['path']}")
            try:
                result = await asyncio.shield(pending["task"])
            except Exception as error:
                raise RuntimeError(f"Reader {pending['request_id']} may still own {pending['lease']['path']}: {error}") from error
            if not isinstance(result, dict) or result.get("timed_out"):
                raise RuntimeError(f"Reader {pending['request_id']} may still be running; retained {pending['lease']['path']}")
            pending["settled"] = True
        if pending.get("cleanup_uncertain"):
            raise RuntimeError(f"Cleanup may still be running; retained {pending['lease']['path']}")
        pending.setdefault("cleanup_id", f"rea-reader-cleanup-{uuid.uuid4().hex}")
        cleanup = {"argv": ["python3", "-I", "-c", READER_CLEANUP, json.dumps(pending["lease"])],
                   "request_id": pending["cleanup_id"], "timeout_s": RUNNER_SLACK_S}
        if "cleanup_task" not in pending:
            pending["cleanup_task"] = _owned_task(
                protocol.invoke_extension(env_url, card, EXEC, cleanup, method="run", timeout=2 * RUNNER_SLACK_S))
        if pending["cleanup_task"].cancelled():
            raise RuntimeError(f"Cleanup has an unknown outcome; retained {pending['lease']['path']}")
        try:
            answer = await asyncio.shield(pending["cleanup_task"])
        except Exception as error:
            pending.pop("cleanup_task", None)
            raise RuntimeError(f"Cleanup of owned reader folder {pending['lease']['path']} is unconfirmed: {error}") from error
        if not isinstance(answer, dict) or answer.get("timed_out"):
            pending["cleanup_uncertain"] = True
            raise RuntimeError(f"Cleanup may still be running; retained {pending['lease']['path']}")
        if answer.get("exit_code") != 0:
            pending.pop("cleanup_id", None)
            pending.pop("cleanup_task", None)
            raise RuntimeError(f"Could not remove owned reader folder {pending['lease']['path']}: {answer}")
        del _PENDING_READERS[token]


async def _reader_views(env_url, card):
    """Each reader's view of its file, by its id, read by REA's reader runner in the computer; a file the home lacks
    has none. A runner that does not answer raises, so the run fails rather than scoring the agent."""
    if not READERS:
        return {}
    if protocol.find_extension(card, EXEC) is None:
        raise RuntimeError(f"the computer at {env_url} offers no {EXEC}, which runs the task's readers")
    await _cleanup_readers(env_url, card)
    views = {}
    for reader in READERS:
        token = uuid.uuid4().hex
        lease = {"path": f"/tmp/rea-reader-{token}", "token": token}
        arguments = json.loads("".join(reader["arguments"]))
        arguments["lease"] = lease
        encoded = json.dumps(arguments)
        params = {"argv": ["python3", "-I", "-c", READER_RUNNER,
                           *(encoded[i:i + 8192] for i in range(0, len(encoded), 8192))],
                  "request_id": f"rea-reader-{token}",
                  "timeout_s": reader["timeout_s"] + RUNNER_SLACK_S}
        task = _owned_task(protocol.invoke_extension(
            env_url, card, EXEC, params, method="run", timeout=reader["timeout_s"] + 2 * RUNNER_SLACK_S))
        _PENDING_READERS[token] = {"env_url": env_url, "lease": lease, "task": task,
                                   "request_id": params["request_id"], "settled": False}
        try:
            answer = await asyncio.shield(task)
        except BaseException as error:
            error.add_note(f"Reader command {params['request_id']} and folder {lease['path']} remain owned for retry.")
            raise
        if not isinstance(answer, dict) or answer.get("timed_out"):
            raise RuntimeError(f"Reader {params['request_id']} may still be running; retained {lease['path']}")
        _PENDING_READERS[token]["settled"] = True
        try:
            view = _reader_answer(reader["id"], answer)
            if view is not None:
                views[reader["id"]] = view
        finally:
            try:
                await _cleanup_readers(env_url, card)
            except asyncio.CancelledError as error:
                error.add_note(f"Reader cleanup remains owned for {lease['path']}; completed reader views: {json.dumps(views)}")
                raise
            except Exception as error:
                raise RuntimeError(f"{error}; completed reader views: {json.dumps(views)}") from error
    return views


def evaluate_with_readers(checks: list, views: dict, readers: dict) -> list:
    """One result per check as evaluate gives it, a check with reader graded on that reader's view of its file."""
    results = []
    for check in checks:
        entry = views.get(check["file"]) if check.get("reader") is None else readers.get(check["reader"])
        passed, description = _verdict(check, entry)
        results.append({"id": check["id"], "result": passed, "description": description})
    return results


def _reader_answer(name, answer):
    """The view the runner's last line gives: None for an absent file, one with an error for a failed reader."""
    stdout = answer.get("stdout") if isinstance(answer, dict) and isinstance(answer.get("stdout"), str) else ""
    try:
        said = json.loads(stdout.strip().split("\n")[-1])
    except ValueError:
        said = None
    if isinstance(answer, dict) and answer.get("exit_code") == 0 and isinstance(said, dict):
        if said == {"absent": True}:
            return None
        if set(said) == {"error"} and isinstance(said["error"], str):
            return {"format": None, "view": None, "error": said["error"]}
        view = said.get("view") if set(said) == {"view"} else None
        if isinstance(view, dict) and view.get("format") in ("json", "text") and "view" in view:
            return view
    raise RuntimeError(f"REA's reader runner did not answer for {name}; it printed: {stdout[-512:]}")
`;

/** The verifier's reader constants: the route, the runner's source once, then each reader's argument and timeout. */
export const renderReaderConstants = (
  readers: readonly DesktopTaskReader[],
): string => `#: The computer route the readers run through, and how long past a reader's own timeout its runner may take.
EXEC = "urn:agentenv:computer-exec/v1"
RUNNER_SLACK_S = ${String(READER_RUNNER_SLACK_S)}
#: REA's reader runner, which runs each reader on a private copy of its file in a fresh home.
READER_RUNNER = ${JSON.stringify(PYTHON_READER_RUNNER)}
READER_CLEANUP = ${JSON.stringify(PYTHON_READER_CLEANUP)}
READERS = [
${readers.map((reader) => `    {"id": ${JSON.stringify(reader.id)}, "arguments": ${JSON.stringify(readerArgumentChunks(reader, undefined))}, "timeout_s": ${String(readerTimeout(reader))}},`).join("\n")}
]
`;
