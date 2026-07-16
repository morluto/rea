#!/usr/bin/env node

import { probeWindowsCapabilities } from "../dist/application/WindowsCapabilities.js";

const report = await probeWindowsCapabilities();
await new Promise((resolveOutput) =>
  process.stdout.write(`${JSON.stringify(report)}\n`, resolveOutput),
);

// node-pty can retain a Windows helper handle after its probe exits. This
// standalone command has no remaining cleanup after its report is flushed.
process.exit(0);
