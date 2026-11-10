# Plan

1. Schema: `screen_judge` in `appTask.ts`, with `screenProblem` keeping such
   tasks to screen judges alone.
2. Judge: `appTaskScreen.ts` renders the screen verifier, finds the files a
   check could read change in (`readableChanges`) and the examples a bundle
   holds (`screenExamplesOf`); `renderTaskVerifier` dispatches to it.
3. Build computer: `DesktopBuildCapture.mark` keeps a screenshot through
   `AgentEnvComputer.addHomeFiles`; the export takes `--screens`.
4. Export: `admitScreenTask` in `DesktopTaskExport.ts`; the relaunch reset in
   `ownlessBody` of `appExportPython.ts`.
5. Witness: `judgeScreenTask` and `bundleTaskDifference` in
   `DesktopBuildWitnessBundle.ts`, with `screenJudgeProcess` in
   `src/desktop/ScreenJudgeProcess.ts`.
6. Docs: the tasks reference, the witness page, the build skill and the
   doctor's endpoint check.
