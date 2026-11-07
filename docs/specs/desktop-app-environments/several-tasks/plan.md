# Plan

1. Export: `admitDesktopTasks` in `DesktopTaskExport.ts` reads every task
   file, resolves each task's end and near miss among the capture's
   checkpoints with `selectStateEnds`, evaluates the checks at the seed, its
   end and its near miss, and renders every task with one eval.
2. CLI: `--task-end` on `export-desktop-application`; the request carries
   it to the export, and the result reports `tasks`.
3. Build: `DesktopBuildExport` writes one file per task and passes
   `--task-end`; `DesktopBuildCapture` refuses an untaken end;
   `DesktopBuildSummary` drafts each later end from the end before it.
4. Contracts: `export_build_environment` takes and reports `tasks`;
   `stop_build_capture` reports `later_drafts`; `mark_build_checkpoint`
   names `end-<task name>` and `near-<task name>`.
5. Docs: the building guide, the tasks, export and build-witness guides,
   and this spec.
6. Tests first: the export of two tasks from one capture with a near miss,
   and its refusals; the build tools' later draft, export and refusal
   through the MCP with the real CLI's outputs; then TreeLine on the arm64
   VM with three tasks in one capture, each witnessed.
