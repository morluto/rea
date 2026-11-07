# Verification

## Tests

- `src/application/desktop/DesktopSeveralTasks.test.ts` exports two tasks
  from one capture, `add-eggs` at `end` and `add-bread` at `end-add-bread`,
  with a near miss of the eggs at `near-add-eggs`, and checks the result's
  `tasks`, both tasks' files, the eval naming both and the README's two
  sections. It refuses `add-bread` checked at `end`, before its change; a
  near miss every check of `add-bread` passes; two tasks of one name; an end
  for a task not given; an end without `=`; and an untaken checkpoint. Each
  of the seven failed on the code before this change, which refused a
  second task file.
- `tests/boundary/mcp/buildSeveralTasksMcp.test.ts` runs the build tools
  against the real CLI's outputs for that capture: `stop_build_capture`
  returns one later draft, from `end` to `end-add-bread`, and
  `export_build_environment` writes both tasks to the computer, passes each
  end as `--task-end` and reports both; an untaken end is refused before the
  export runs. Both failed before the change.

## TreeLine, arm64

On the arm64 Ubuntu 24.04 build host with agentenv-framework 0.9.1431, one
capture of TreeLine 3.1.5 from the Ubuntu archive, through REA's MCP tools:

- Seed: the Book List template saved as `Documents/books.trln`, one category
  `SF Books` with two authors and two books.
- `rename-category` at `end`: the category renamed `Science Fiction`.
- `set-foundation-year` at `end-set-foundation-year`: Foundation's copyright
  1951 to 1952.
- `add-asimov-book` at `end-add-asimov-book`: I, Robot added under Isaac
  Asimov with copyright 1950.
- Near misses, after the last end: Foundation 1925 and I, Robot 1905, marked
  `near-set-foundation-year` and `near-add-asimov-book`, then the category
  `Science Fictoin`, marked `near-rename-category`.

`stop_build_capture` drafted the first task from `seed` to `end` and the two
later ones each from the end before it, each showing only its own change:
the category's name, Foundation's copyright, and the new book with Asimov's
second child. `export_build_environment` kept all three, each failing on the
seed and at its near miss, and wrote one eval:
`tasks = ["rename-category", "set-foundation-year", "add-asimov-book"]`.

Each task was then witnessed on its own fresh computer of the bundle, from
its prompt: the seed failed a check, the edit passed every check, a near
miss (`Science Fictoin`, 1925, 1905) failed one and the reset seed failed
again, so all three records, `witness-rename-category`,
`witness-set-foundation-year` and `witness-add-asimov-book`, hold.
`agent-env run --dry-run` of the bundle plans the eval's three tasks. No
solver ran.

Not tested: a near miss whose only failures come from a view that could not
be read or is cut short, which the export refuses like such a seed, and an
`end-<task name>` taken before `end`, which gets no later draft.
