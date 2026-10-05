import type { JavaScriptReplayConfiguration } from "../application/JavaScriptReplayPlanning.js";

/** Default runtime paths; callers can override these through parsed configuration. */
export const defaultJavaScriptReplayConfiguration =
  (): JavaScriptReplayConfiguration => ({
    nodePath: process.execPath,
    bubblewrapPath: "/usr/bin/bwrap",
    systemdRunPath: "/usr/bin/systemd-run",
    systemctlPath: "/usr/bin/systemctl",
    shellPath: "/usr/bin/bash",
  });
