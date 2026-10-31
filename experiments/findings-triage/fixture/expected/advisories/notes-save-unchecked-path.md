# notes:save writes to a path chosen by the renderer

The main-process handler for the `notes:save` IPC channel (main.js:20) passes its `filePath` parameter, the first argument sent by the renderer, as argument 0 of the call at main.js:21. REA resolves that parameter-to-argument flow and links the call target to `writeFile` on the `fs` binding as a candidate; main.js requires `node:fs/promises`, and REA leaves the binding's value unresolved. REA reports zero sender-validation observations. The preload's `notes.save` member forwards its arguments to this channel.

- Verdict: defect
- Claim type: structure
- Severity: high
- Disclosure: private
- Strength: derived (shipped-artifact)

| Evidence                                                              | Operation                      | Confidence | Authority        |
| --------------------------------------------------------------------- | ------------------------------ | ---------- | ---------------- |
| `ev_3607d6dd9ce6a14db9b4b60a4617ac216c36c9728063f33dd75c6bc3f521b6d2` | analyze_javascript_application | derived    | shipped-artifact |

**Impact:** Any script running in the window can create or overwrite any file the application user can write by calling `window.notes.save` with an absolute path.

**Remediation:** Do not accept a path from the renderer. Write to a fixed file under `app.getPath("userData")`, or resolve the requested name against that directory and reject results outside it. Validate `event.senderFrame` in both `notes:*` handlers.

Limitations of the cited Evidence:

- CommonJS and ESM binding relationships were recovered from inert syntax and resolved only within the inventoried artifact container.
- Electron API identity follows proven lexical module aliases and structurally verified module-namespace interop. Other reassignments, dynamic selections, and visibly overwritten namespace members are unresolved; missing findings do not establish absence. Arbitrary call side effects and runtime registration are not evaluated.
- Electron relationships are derived from inert syntax; runtime registration, reachability, defaults, and enforcement remain unproven.
- Graph coverage is incomplete; unavailable facts remain explicit and must not be read as absence.
- JavaScript and HTML were parsed as inert text; bundle bootstrap code was never executed.
- Static imports, entrypoints, workers, endpoints, and storage relationships do not prove runtime execution.
- Static paths and relationships may remain unresolved when expressions are dynamic or obfuscated.
- Webpack/Rspack factories were recovered from AST literals; REA did not invoke push handlers or bundle bootstrap code.
- index.html has 1 inline JavaScript body starting at line 11 that was not analyzed; endpoints, storage, imports and other facts in it are absent from the evidence.

Target: triage-notes, `sha256:771d6f4fab8349260a8c3d4d2b81b54fe200ab483b0508502e6a469b87c51deb`

<!-- findings-triage:05fa07a51ac71cfa -->
