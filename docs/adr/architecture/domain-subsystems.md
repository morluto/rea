# Split `src/domain` by subsystem behind one entry point

## Status

Proposed, 2026-11. Moves are scheduled one subtree per change after the open
JavaScript-analyzer and output-view work on the same files has merged.

## Context

`src/domain` is the pure layer: it may import only `domain` and `contracts`, and
the module-boundary check enforces that. Because purity was the only rule, any
I/O-free code moved there regardless of its role. Measured on 2026-11-15:

| Subtree                  | Production files                                                         | Lines | Role                                                                         |
| ------------------------ | ------------------------------------------------------------------------ | ----- | ---------------------------------------------------------------------------- |
| `domain/javascript/`     | 180                                                                      | 62.8K | static JavaScript analysis engine                                            |
| `domain/analysisView/`   | 147                                                                      | 43.5K | output projection: summaries, paging and row selection for retained Evidence |
| `domain/desktop/` (part) | `appBuild`, `appExport*`, `appDownloadInstall`, `appTask*`, `shellQuote` | —     | shell, Python and inline Node script generation for desktop environments     |

Outside the subtree, 108 production files import 64 different modules inside
`domain/javascript/`, and 70 files import 42 modules inside
`domain/analysisView/`. Nothing states which of those modules are the
subsystem's interface, so every internal module is public by accident and a
refactor inside the engine can break any of 108 importers.

Splitting `src/domain` into layer folders such as `analysis/` and
`presentation/` would only rename the problem: each would again collect
unrelated subsystems with no interface.

## Decision

Each large subsystem in `src/domain` becomes its own top-level module with one
public entry point. Code outside the module imports only its `index.ts`; files
inside the module import each other directly.

| Module                  | Moves from                                           | Public entry                    |
| ----------------------- | ---------------------------------------------------- | ------------------------------- |
| `src/javascriptEngine/` | `src/domain/javascript/`                             | `src/javascriptEngine/index.ts` |
| `src/analysisView/`     | `src/domain/analysisView/`                           | `src/analysisView/index.ts`     |
| `src/desktopScripts/`   | the script-generation files of `src/domain/desktop/` | `src/desktopScripts/index.ts`   |

- **Names.** Top-level `src/` directories are camelCase. `src/javascript/`
  already names the JavaScript artifact provider, so the engine is
  `javascriptEngine`.
- **Layers.** Each module is declared in `scripts/lib/module-layers.mjs`. The
  engine and the view projection are pure and stay in the `domain` layer (the
  contracts layer imports their schemas today); the module-boundary purity rule
  extends to them. `desktopScripts` is pure as well. A later change may give a
  module its own layer once its schema consumers in `contracts` are resolved.
- **Entry point rule.** The boundary check gains a table of subsystem modules
  and their entry file. An import that resolves into a module from outside it
  must resolve to the entry file, including type imports, re-exports and
  `#`-mapped specifiers. Undeclared directories already fail the layer check,
  so a new subsystem chooses a layer and, if it has an interface, an entry.
- **Entry contents.** `index.ts` re-exports exactly the symbols used outside the
  module at the time of the move; it is the only barrel the module has. A new
  external use adds an export there, which makes interface growth visible in
  review.
- **Moves.** Files move with `git mv`; each move commit contains only renames,
  import specifier updates and the new `index.ts`, and is listed in
  `.git-blame-ignore-revs` once it has merged. One subtree per change, in the
  order `desktopScripts`, `analysisView`, `javascriptEngine`, each after the
  open changes that edit that subtree have merged.
- **Not part of this decision.** No npm workspace or package split. Wire
  schemas that `contracts` reads from these modules stay where they are until
  the operation registry decides their owner.

### TypeScript project references

Project references split the program into separately built projects and allow
incremental type checks per module. They do not enforce the entry rule: a
project that references another may import any of its files, not only
`index.ts`. The entry rule therefore stays in the boundary check whether or not
references are adopted. They are not adopted now:

- **Cost.** Each module needs its own `tsconfig` with `composite: true` and
  declaration emit; `tsconfig.json`, `tsconfig.build.json` and the two
  verification configs, the turbo typecheck task and `scripts/run-typescript.mjs`
  change from one program to a `tsc --build` graph. References may not form
  cycles, and `contracts` and `domain` import each other today, so the engine
  and view modules cannot be referenced projects until that cycle is gone.
  Test files that import module internals would need their own project per
  module.
- **Benefit.** The compiler refuses an import from a project that is not
  referenced, which checks dependency direction between modules (the layer
  check already does this), and warm type checks may be faster. The type-check
  time benefit is unmeasured.
- **Revisit** when `contracts <-> domain` has no mutual imports, starting with
  `javascriptEngine` (the largest and most self-contained module), and measure
  cold and warm `npm run typecheck` before and after.

## Consequences

- Each subsystem has a written interface; internal refactors cannot break
  outside importers without changing `index.ts`.
- `src/domain` shrinks to Evidence, results, errors, identity, comparisons and
  format declarations, matching its description in the architecture map.
- The moves touch every importer once; changes in flight on the same files need
  a rebase. Scheduling one subtree per change after the related open work
  merges limits that cost.
- The entry barrel adds one hop for readers and a re-export list to maintain;
  the alternative, every module public, is what produced 64 imported internals.
