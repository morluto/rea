# Plan

1. Schema: `readers` and the `reader` field in `appTask.ts`, with
   `readersProblem` for ids, files, `{file}`, kinds by output and unread
   readers; `DesktopTask.readers` only when the file has some.
2. Runner: `PYTHON_READER_RUNNER`, `readerCommand`, `readerArguments` and
   `readerAnswerView` in `appTaskReaders.ts`.
3. Evaluators: `evaluateTaskChecks` takes the readers' views by id, and the
   verifier's `evaluate_with_readers` does, leaving `evaluate` as it was.
4. Verifier: `appTaskPython.ts` renders `READER_RUNNER`, `READERS`,
   `_reader_views` and `evaluate_with_readers` only for a task with readers,
   so a task without renders as before.
5. Application: `readerViewsOfBytes` in `DesktopTaskReaders.ts`;
   `runReaderHere` in `src/desktop/TaskReaderProcess.ts`;
   the witness runs readers through `AgentEnvComputer.exec`; the export runs
   them on `shippedSeedBytes` and the end's retained content.
6. Docs: the tasks reference, the witness page, the build skill's recipes for
   GIMP, Blender and LibreOffice, and the draft note.
