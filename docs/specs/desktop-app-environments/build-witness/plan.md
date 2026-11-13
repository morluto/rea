# Plan

1. Capture acknowledgement: `desktopCaptureEventSchema` and
   `desktopCaptureProgressSchema` in the capture's domain schema; the session
   reports `window_open` and `checkpoint_refused`, the capture a
   `checkpoint` event after each checkpoint is taken; the CLI writes the event
   in its progress line.
2. Controller: `bridge/agentenv/capture.py`, with `start`, `mark`, `stop`,
   `run` and `list`, each answering one JSON line.
3. Adapter: `AgentEnvComputer` gains `exec`, `homeFiles`, `appData` and
   `waitUntilReady`, and reports start progress;
   `src/desktop/BuildComputerController.ts` runs the controller and fetches a
   home folder in bounded, checked batches.
4. Domain: `buildCapture.ts` (checkpoint names, `seed` and `end`) and
   `buildWitness.ts` (stages, their order and expectations, the app's state
   views); `computerActions.ts` gains `reset`.
5. Application: `DesktopBuildCapture` (start, mark, stop and draft) with
   `DesktopBuildExport` and the shared `DesktopBuildCommands`, and
   `DesktopBuildWitness` with `DesktopBuildWitnessRecord`, held per live
   computer by `DesktopBuildComputers`, which also resets;
   `DesktopBuildSteps` serves the step tools by `computer_id`. The output
   tree writer moves to `DesktopOutputTree.ts` for the export, the build
   export and the witness record.
6. MCP: contracts, effects, CLI-parity list, registration with heartbeat
   progress.
7. Launch from the home in `launchCommand` and the build bundle; the packing
   script.
8. Docs: the guide, the capture, export and build computer guides, this spec.
9. Tests first: the witness rules, the reset action, the launch commands, the
   capture's acknowledgements on Linux, and boundary tests through the MCP
   tools with a fake computer that runs the real controller against a REA
   stand-in printing the real CLI's outputs; then the amd64 VM.
