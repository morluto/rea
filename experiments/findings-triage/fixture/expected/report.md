# triage-notes static triage

- Target: triage-notes, `sha256:771d6f4fab8349260a8c3d4d2b81b54fe200ab483b0508502e6a469b87c51deb`
- Bundle: `sha256:221a7bc4efcf588244ee4909851a5838895b5b3f4484cfbcfe5b3d828a495f7b`, 5 Evidence records, 3 residual unknowns (4 revisions)

| Verdict    | Findings |
| ---------- | -------- |
| defect     | 1        |
| suspect    | 1        |
| unknown    | 1        |
| acceptable | 1        |

## Defects

### notes-save-unchecked-path: notes:save writes to a path chosen by the renderer

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

## Suspects

### insecure-web-preferences: BrowserWindow disables webSecurity and the renderer sandbox

The only BrowserWindow (main.js:7) sets the literal webPreferences `webSecurity: false` and `sandbox: false`. Disabling webSecurity removes the same-origin policy for the window. Whether that is exploitable depends on what the window loads, which the static analysis does not establish.

- Verdict: suspect
- Claim type: structure
- Severity: medium
- Disclosure: public
- Strength: derived (shipped-artifact)
- Residual unknown: `unk_0d2d2b37bedc6ea49e59cfd31678634d377daf4e3ec3c9566a83bd83ef7fb7e4`

| Evidence                                                              | Operation                      | Confidence | Authority        |
| --------------------------------------------------------------------- | ------------------------------ | ---------- | ---------------- |
| `ev_3607d6dd9ce6a14db9b4b60a4617ac216c36c9728063f33dd75c6bc3f521b6d2` | analyze_javascript_application | derived    | shipped-artifact |

**Impact:** Content loaded from outside the application directory would run without same-origin restrictions in an unsandboxed renderer that can call `window.notes`.

**Remediation:** Remove `webSecurity: false` and set `sandbox: true` unless a documented requirement needs them.

**Next probe:** `capture_electron_scenario`: Exercise the window and record every resource it loads; a non-local origin makes this a defect.

## Unknowns

### notes-save-page-callers: Which page code calls window.notes.save

REA did not analyze the inline script in index.html, so the Evidence does not show which page code calls `window.notes.save` or where its path argument comes from. This affects how the notes:save defect is reached in normal use, not whether the handler accepts arbitrary paths.

- Verdict: unknown
- Claim type: behavior
- Strength: derived (shipped-artifact)
- Residual unknown: `unk_106b433435da34f219b5150a81ecea1f00ccfd5d9efb2d597113ae8391a5ffe3`

| Evidence                                                              | Operation                      | Confidence | Authority        |
| --------------------------------------------------------------------- | ------------------------------ | ---------- | ---------------- |
| `ev_3607d6dd9ce6a14db9b4b60a4617ac216c36c9728063f33dd75c6bc3f521b6d2` | analyze_javascript_application | derived    | shipped-artifact |

**Next probe:** `capture_electron_scenario`: Click #save in a controlled replay and record the notes:save invocation arguments.

## Acceptable

### preload-bridge-scope: Preload exposes two named functions, not ipcRenderer

With `contextIsolation: true`, preload.js exposes one contextBridge API, `notes`, as an object literal with exactly the members `load` and `save` and no unknown members. Both members invoke literal channels that pair with main-process handlers; `ipcRenderer` itself is not part of the recovered API.

- Verdict: acceptable
- Claim type: structure
- Strength: derived (shipped-artifact)

| Evidence                                                              | Operation                      | Confidence | Authority        |
| --------------------------------------------------------------------- | ------------------------------ | ---------- | ---------------- |
| `ev_3607d6dd9ce6a14db9b4b60a4617ac216c36c9728063f33dd75c6bc3f521b6d2` | analyze_javascript_application | derived    | shipped-artifact |

## Evidence

### `ev_3607d6dd9ce6a14db9b4b60a4617ac216c36c9728063f33dd75c6bc3f521b6d2`

- Operation: analyze_javascript_application
- Confidence: derived
- Authority: shipped-artifact

Limitations:

- CommonJS and ESM binding relationships were recovered from inert syntax and resolved only within the inventoried artifact container.
- Electron API identity follows proven lexical module aliases and structurally verified module-namespace interop. Other reassignments, dynamic selections, and visibly overwritten namespace members are unresolved; missing findings do not establish absence. Arbitrary call side effects and runtime registration are not evaluated.
- Electron relationships are derived from inert syntax; runtime registration, reachability, defaults, and enforcement remain unproven.
- Graph coverage is incomplete; unavailable facts remain explicit and must not be read as absence.
- JavaScript and HTML were parsed as inert text; bundle bootstrap code was never executed.
- Static imports, entrypoints, workers, endpoints, and storage relationships do not prove runtime execution.
- Static paths and relationships may remain unresolved when expressions are dynamic or obfuscated.
- Webpack/Rspack factories were recovered from AST literals; REA did not invoke push handlers or bundle bootstrap code.
- index.html has 1 inline JavaScript body starting at line 11 that was not analyzed; endpoints, storage, imports and other facts in it are absent from the evidence.

## Residual unknowns

| Unknown                                                                | Revision | Status              | Severity | Question                                                                                       | Triaged by               |
| ---------------------------------------------------------------------- | -------- | ------------------- | -------- | ---------------------------------------------------------------------------------------------- | ------------------------ |
| `unk_0d2d2b37bedc6ea49e59cfd31678634d377daf4e3ec3c9566a83bd83ef7fb7e4` | 1        | open                | medium   | Does the window with webSecurity disabled load content from outside the application directory? | insecure-web-preferences |
| `unk_106b433435da34f219b5150a81ecea1f00ccfd5d9efb2d597113ae8391a5ffe3` | 1        | open                | high     | Which page scripts call window.notes.save, and can the path argument come from page input?     | notes-save-page-callers  |
| `unk_e933b47d459bdea870f4fe87297ae00dbfb683f946a964e6a43723be6f24e65c` | 2        | resolved (verified) | medium   | Does preload.js expose ipcRenderer or another Electron object directly to the page?            | none                     |
