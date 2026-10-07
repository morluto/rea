# REA website writing and design guide

> A good website is like a good paper: easy to follow, clear and concise, with a clean, refined presentation.
>
> — N0zoM1z0

For REA, that means a concrete question, a figure that explains the process,
evidence the reader can inspect, and a useful next step. A clean, refined
appearance comes from precise wording, readable figures, consistent typography
and deliberate spacing.

Use this guide for new pages and revisions. Start from an existing page and
reuse `public/assets/styles.css` and `public/assets/main.js`. Local preview and
publication commands are in [README.md](README.md).

## What a reader should understand

A reader scanning for five seconds should see the subject and the result. After
ten seconds, the main figure should explain the sequence. After fifteen seconds,
the prompt or first example should show how to start.

These are reading goals, not a requirement to fit every investigation above the
fold. Keep the main path short and let readers open the supporting details.

## Write the task directly

Name the software, behavior or action in headings. Give the opening paragraph
one job: explain what the page covers. Use concrete verbs such as install, trace,
read, compare and calculate.

| General wording                                  | More useful wording                                                |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| Start with a question.                           | Set up REA.                                                        |
| Follow a feature across the app.                 | Trace an Electron CSV export.                                      |
| Following a copy through Notion.                 | How Notion copies text and HTML.                                   |
| A position becomes a sound.                      | Calculate left/right sound panning.                                |
| Follow the investigation.                        | REA case studies.                                                  |
| Reviewed boundary / source owner / target extent | The helper / its surrounding code / the code section being checked |

Questions also work when they name a behavior: “Where is the CSV created?” and
“How does a copied block keep its structure?” give the reader something specific
to look for.

Explain necessary terms where they first matter. An IPC channel can be described
as a named message between Electron processes. Keep exact API names, addresses
and JSON paths in the code or result they identify.

Give each paragraph new information. A diagram can summarize a sequence, while
the code below explains individual steps. Repeating that REA supplies
instructions, callers and constants in several surrounding paragraphs adds no
new step. Explain that role once, then show the results.

Use captions for useful context: which values are illustrative, where an excerpt
comes from, or what a check covers. Scope a claim positively and precisely:
“The compiled function matches 63 bytes” is more useful than a broad claim
followed by several qualifications.

## Build a page around one question

### Guides

1. Name the task and introduce a small example.
2. Show a short flow of the relevant files, calls or observations.
3. Provide a copyable agent prompt and its prerequisites.
4. Explain the important code or returned fields.
5. Let the reader try the example, with a command or one ZIP download.
6. State the expected result and where to find it.
7. Offer a specific follow-up question or another relevant guide.

A command should work after the steps immediately before it. Use `npx` for a
first CLI query when global installation is optional. Browser examples should
open the hosted fixture by default; a local URL needs a server-start step. Keep
target paths, debugging endpoints and other required inputs explicit.

### Case studies

1. Introduce the project and the particular feature being examined.
2. Show a figure that explains the investigation or behavior.
3. Give a short example prompt.
4. Pair important REA queries with selected returned evidence.
5. Connect that evidence to readable source or an explanation.
6. Explain how the result was checked.
7. Link the reconstruction repository and supporting sources.

Show REA's useful contribution through a concrete finding: a missing stack
argument, a caller, bytes behind a constant, or source ranges in a packaged
bundle. Explain what the agent does with that finding. Credit source
interpretation, reconstruction and external checks to the work that performed
them.

Keep a second investigation optional. Notion's clipboard path is the main
story; Markdown tables and SQLite are additional examples. Native `<details>`
keeps them available without interrupting the first question.

Keep the explanation on the website. Repository links provide source,
reproduction instructions and further evidence. Use specific links for those
purposes, and immutable commit links for checkpoint-dependent facts.

## Make figures explain a relationship

Each figure should answer a question that a reader can name. Choose the visual
form that fits it:

| Relationship                              | Existing example                         | Useful form                                        |
| ----------------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| Analysis and verification steps           | DX-Ball sound pan                        | Flow with separate verification branches           |
| Code across process boundaries            | Electron CSV export and Notion clipboard | HTML flow with APIs and channel names              |
| A mathematical transformation             | TH04's fixed and aimed rings             | SVG drawn from the angle formula                   |
| Original instructions and readable source | DX-Ball and TH04                         | Selectable HTML code with matching step highlights |
| A request caused by an action             | Notes browser export                     | Flow, observed result table and script excerpt     |

Use SVG or semantic HTML for diagrams with exact text, numbers and arrows.
Generated illustrations can help explore a layout, but the published labels,
relationships and values need to be checked. [figures.md](figures.md) records the
existing assets and original layout references.

Keep labels short, align related nodes, and give arrows an explicit direction.
Use color to identify the relevant operation or connection. Add a legend when
the visual encoding needs one. Avoid making the diagram repeat the entire page.

State illustrative inputs in the caption. TH04's diagram uses a count of 16 and
a player direction of 40; its dots are calculated from those values. Give an
image useful alternative text, and keep source code as selectable HTML.

On small screens, HTML flows stack. A wide SVG can have its own horizontal scroll
and an “Open figure” link. A diagram should remain readable at its intended
display size; scaling small labels down is not a mobile layout.

## Use the existing visual system

The shared stylesheet defines the site. Its core colors are:

| Token      | Value     | Use                              |
| ---------- | --------- | -------------------------------- |
| `--page`   | `#ffffff` | Page background                  |
| `--ink`    | `#20252b` | Main text                        |
| `--muted`  | `#5b6570` | Secondary text                   |
| `--line`   | `#e0e5e9` | Section and component boundaries |
| `--soft`   | `#f4f6f8` | Code and supporting surfaces     |
| `--accent` | `#294f82` | Links and meaningful highlights  |

Use the system sans-serif stack for prose and the shared monospace stack for
code. The current container is at most 1080px wide, with article text limited to
760px. Reuse the existing heading sizes, line heights, section spacing and
component classes.

Whitespace separates ideas. Thin rules identify sections. Headings establish
hierarchy. The blue accent identifies something useful. Keep these elements
consistent rather than adding a new treatment for each page. Decorative
gradients, large shadows and scroll effects do not help explain the examples.

Agent terminals contain short, copyable prompts. Use the existing continuous
cursor animation and reduced-motion behavior. Label an example prompt as an
example; a real recorded result belongs in an evidence block. Copy buttons
should copy only the intended text, without the prompt symbol or cursor.

Use `minmax(0, 1fr)` for grid tracks that contain long commands or nested panels.
Allow code blocks to scroll within their own area. Check expanded details as
well as the default page. Document-level horizontal scrolling usually means a
component needs a width constraint; hiding it can conceal content.

## Keep evidence accurate and public

Preserve target identity, source locations, relevant versions and the scope of
checks. Keep observations, interpretation and unknowns distinguishable in plain
language. Put lengthy provenance in an evidence document or collapsed details.

Label simplified source and selected instruction excerpts. When compiler checks
apply to the maintained project source, say so; a readable summary is a separate
presentation of the calculation. Historical checks and a fresh REA inspection
retain their own dates and attribution.

Use generic example data and display paths. Machine paths, personal account
identifiers, credentials, local configuration, full vendor bundles and raw
captures belong outside the public website. If a path is shortened in a displayed
query, identify that in its caption and keep the original capture separately.

## Review and publish

Before merging a change:

- Read the default page in order. Check that every section advances the task.
- Open details and confirm that sources and extra examples remain usable.
- Verify commands, prerequisites, expected results and downloadable files.
- Keep links and asset paths working at both `/` and `/rea/`.
- Check desktop, intermediate and mobile widths, including 320px.
- Check copying, downloads, code-step selection, keyboard access and reduced
  motion. Core content and native details should work without JavaScript.
- Confirm that figures and code excerpts agree with the supporting evidence.
- Run site preparation, verification and formatting checks.

Match verification to the change. Copy edits need page and interaction checks.
New analysis or behavior claims need the real evidence that supports them; a mock
or a page-loading check cannot establish those claims.

Follow the PR review and CI process, then publish using the existing manual
`website-pages.yml` workflow on `main`. Ordinary commits should not publish the
site. After deployment, check the live page and confirm it matches the reviewed
version. The legacy VitePress build remains separate from the Pages publisher.
