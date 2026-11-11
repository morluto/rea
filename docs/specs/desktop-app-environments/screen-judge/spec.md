# Screen judges: checking state no file shows

## Outcome

A task can check what an app keeps only on screen, such as a calculator's
result, through a screen judge: a model answers a yes-or-no question on a
screenshot of the computer, calibrated by two labelled screenshots from the
build. The export ships the judge in the bundle, the witness runs that same
judge on fresh screenshots, and the verifier runs it at grading time. REA
calls no model itself.

## Requirements

- Task file: a check `{id?, kind: "screen_judge", question}`, the question
  1 to 2,000 characters after trimming. A task with one holds only screen
  judges and no readers.
- Build computer: at each acknowledged checkpoint REA takes a JPEG
  screenshot (quality 70) through the driver and writes it under the home at
  `<capture folder>/screens/<checkpoint>.jpg` with `data/add`; a screenshot
  that fails leaves the checkpoint as it is. The export runs with
  `--screens <capture folder>/screens`.
- Export: a screen-judged task is refused when an owned file changed between
  the seed and the end in a way a check could read (readable or absent at
  both ends, and different), naming the files, and when the seed's or the
  end's screenshot is missing. It judges nothing: `failing_on_seed` is empty
  and a limitation says the witness checks the questions. `verify.py` holds
  the questions, the seed's screenshot as the failing example and the end's
  as the passing one. An app that owns no files gets a reset that only
  relaunches it, so the witness can take `after_reset`.
- Verifier: once the agent stops it waits 1 s, takes a JPEG screenshot
  through the computer's `computer_screenshot` tool and asks each question 3
  times; a question passes when at least 2 answers are yes. Each vote shows
  the instructions, the two labelled examples and the screenshot, and asks
  for `{verdict, reason}` by JSON schema; a failed call is asked again, up to
  3 times, then the verifier raises. The model is `[model.roles] judge`, else
  `[model] default`, else `anthropic/claude-sonnet-5-5`, through agentenv's
  `resolve_model_call`; without an endpoint it raises, so the run fails
  rather than scoring the agent. `agent-env run --judge-model` does not reach
  it.
- Witness: for a screen-judged task, `check_build_task` waits 1 s, takes a
  screenshot, and runs the bundle's `verify.py judge <check> <screenshot>`
  with the agentenv runner's Python and REA's environment; it refuses on a
  computer not started from the bundle, and a judge that fails fails the
  check call. On a bundle computer it compares the bundle's verifier with the
  task's using the examples the bundle holds.
- Doctor: the model endpoint check names screen-judged tasks as needing it.

## Non-goals

- Judging the screen in the export or drafting questions.
- Mixing screen judges with file checks or readers in one task.
- Passing `--judge-model` through; agentenv gives an outcome verifier no run
  overrides.
