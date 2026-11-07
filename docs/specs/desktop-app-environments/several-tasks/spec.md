# Several tasks

## Outcome

One capture yields an environment with several tasks. The building agent
makes each task's change on top of the last in one capture and marks its own
end checkpoint, and may mark a near miss of any task. The export checks each
task against the seed, its own end and its near miss, writes every task's
steps and verifier, and lists them all in the bundle's eval. Each task is
then witnessed on its own fresh computer of the bundle.

## Requirements

- `export-desktop-application` takes `--task` once per task and
  `--task-end NAME=CHECKPOINT`, repeatable, for each task checked at a
  checkpoint other than `--end-checkpoint`. It refuses two tasks of one name,
  an end not in `NAME=CHECKPOINT` form or naming none of the tasks, two ends
  for one task, and a checkpoint the capture does not hold once at or after
  the seed.
- Each task's checks are evaluated at the seed, as the bundle ships it, and
  at its own end, and the existing rules hold per task: a check failing at
  its end, every check passing on the seed, or no check failing on what the
  seed's views show refuses the task. Each refusal names the task and the
  end checkpoint it was checked at.
- A checkpoint `near-NAME` is task NAME's near miss. When the capture took
  it, at or after the seed, the export refuses the task unless a check fails
  on what the near miss's views show; a failure for want of a whole or
  readable view does not count.
- The result's `tasks` lists, per task, its name, number of checks, end
  checkpoint, the checks failing on the seed, and the near miss's checkpoint
  or null with the checks failing there. The bundle holds every task's
  `tasks/NAME.json` and `artifacts/NAME-check/verify.py`, one
  `evals/ENV.toml` naming them in the order given, and a README section per
  task saying where it was checked.
- `export_build_environment` takes `tasks`, at most 8, each
  `{task, end_checkpoint}`, the end `end` by default, and refuses an end the
  stopped capture did not take before running anything in the computer. It
  writes each task to its own file in the computer and passes each task's
  end as `--task-end`; the tasks together must fit in 96 KiB as passed. Its
  result's `tasks` is the export's.
- `stop_build_capture` returns `later_drafts`: one per checkpoint named
  `end-<task name>` taken after `end`, drafted with
  `describe-desktop-application-task` from the end checkpoint before it, so
  it shows only that task's change, with the draft or the reason there is
  none.
- `check_build_task` needs no change: on a computer of the bundle it takes
  any task the bundle holds, by its rendered steps and verifier, and a
  computer is witnessed once, so each task is witnessed on its own computer.

## Non-goals

- No reset inside a capture: later tasks are made on top of earlier ones,
  and their checks should not read what a later task changes.
- No measured difficulty; solves stay outside REA here.
