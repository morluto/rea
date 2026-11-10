# Plan

1. Domain: the task schema and its refusals (`appTask.ts`), the TypeScript
   evaluator (`appTaskChecks.ts`), the Python verifier and the task, eval and
   README renderers (`appTaskPython.ts`), and the net change with suggested
   checks (`appTaskDraft.ts`).
2. Export: share the owned paths and state files by home path between the
   export and the draft, read and validate the task file against the seed
   and end views, and write its files with the bundle.
3. CLI: `describe-desktop-application-task` and the export's `--task`.
4. Docs and skill: the user guide, links, and a skill reference for agents.
5. Tests: one fixture of views and checks of every kind with expected
   outcomes, asserted for the TypeScript evaluator and for the rendered
   `verify.py` under `python3 -I`; suggestions per format; the export and the
   draft on the synthetic capture; the real Mousepad and LibreCAD captures.
