# REA website

> A good website is like a good paper: easy to follow, clear and concise, with a clean, refined presentation.
>
> — N0zoM1z0

An English static website with explanatory figures, worked guides and DX-Ball, Notion, TH04 and CTF investigations.
The public files are in `website/public/`. The site uses HTML, CSS and a small
script for copying code and following the assembly-to-C comparison. Python
packages the downloadable example; there is no frontend bundler or npm dependency.

[style-guide.md](style-guide.md) explains the writing, page structure, figures,
visual system and review process. Read it before adding or revising a page.

## Local preview

From the repository root:

```sh
python3 scripts/prepare-website.py
python3 -m http.server 4173 --bind 127.0.0.1 --directory website/public
```

Open <http://127.0.0.1:4173/>. Refresh the browser after editing a file.

## Pages

- `public/index.html`: product introduction and case-study overviews.
- `public/showcase/index.html`: the case-study index.
- `public/showcase/dx-ball/index.html`: sound-pan investigation and project status.
- `public/showcase/notion/index.html`: Notion's Electron clipboard bridge and rich clipboard format.
- `public/showcase/th04/index.html`: TH04's 16-bit DOS bullet-angle calculation and compiler checks.
- `public/showcase/ctf/index.html`: DownUnderCTF's masked-squares flag checker, extracted equations and real process captures.
- `public/get-started/index.html`: agent setup, first CLI result and provider guides.
- `public/guides/`: a guide hub and native, JavaScript/Electron and browser examples.
- `public/examples/`: downloadable Electron source and an interactive Notes browser app.
- `public/assets/`: shared styles, interactions, favicon and explanatory figures.

Navigation and assets use relative paths, so the same files work at the local
root and a GitHub Pages project path such as `/rea/`.

## Content

Keep the copy direct and specific. Explain the task and the result before listing
tool names. Setup commands and runtime requirements should match the released
package. Keep the core learning path inside the site. Source, issue and evidence
reference links may point to the corresponding repositories.

[evidence/guide-examples.md](evidence/guide-examples.md) records the published
REA package, example digests and observed results behind the guides. The Notes
Electron fixture is for static analysis; Electron is not a prerequisite for
following that example. The separate Notes browser app runs in the local preview
and constructs a CSV download after fetching its JSON data.

The Electron guide offers one ZIP containing the six source files under
`notes-example/`. `scripts/prepare-website.py` generates this download from
an explicit file list, with fixed timestamps and permissions. The ZIP is ignored
by Git; website checks and each manual publication regenerate it before checking
and uploading the public directory. The verifier checks that its entries match
the current source and contain no extra files.

Agent terminals show example prompts, not transcripts of previous
investigations. All cursors blink continuously with the same CSS animation,
respecting reduced-motion preferences. Both the prompt and animation work
without JavaScript. The homepage and agent setup section share a copyable
installation prompt; setup still presents its plan for approval.

Reading pages share a small `↑ Top` link at the bottom right. It appears after
scrolling and returns to the page header, with smooth scrolling when reduced
motion is disabled. Keyboard activation returns focus to the first navigation
link. Without JavaScript, the link stays visible and uses its `#top` anchor.

DX-Ball figures and findings refer to the linked 7 October 2026 checkpoint,
commit `a55dca27ec0a07018c1b2c95ae2be027f7d8c3c4`. Update those links and figures
together when moving to another checkpoint. Case-study source excerpts come
from the MIT-licensed DX-Ball reconstruction repository.

The assembly excerpts were transcribed from the project's saved REA/Ghidra
Evidence. [evidence/dx-ball-sound-pan.md](evidence/dx-ball-sound-pan.md) records
their provenance and the scope of the validation claims. The original executable
and complete private Evidence records are not website assets.

The homepage and DX-Ball overview diagrams are maintained as SVG source. Initial layout references were
created with the built-in image generation tool; [figures.md](figures.md) retains
their prompts and the current asset notes. Figures provide an overview;
REA requests, assembly and C remain selectable HTML text. On narrow
screens, the diagrams scroll horizontally and can also be opened at full size.
The worked guides use semantic HTML flows that stack vertically on smaller
screens. The Electron teaching example uses CommonJS, matching its preload
code; the scoped lint override admits `require` only in that example directory.

The Notion case follows the same HTML figure style. Its short excerpts explain
the packaged clipboard bridge; separate web-cache probes illustrate the rich
clipboard format, with Markdown tables available as an additional example in
collapsed details. Only selected source details and generic
example data belong on the site. Machine paths, account identifiers, local
configuration, complete vendor bundles and raw captured results stay outside
the website.
[evidence/notion-clipboard.md](evidence/notion-clipboard.md) records the REA
package version, selected findings, source anchors and module-probe scope.

## TH04 case study

The TH04 case inspects the original PC-98 DOS angle helper through REA 4.1.0.
Its selected instructions are paired with readable C++ and a source SVG of
fixed and aimed rings. [evidence/th04-bullet-ring.md](evidence/th04-bullet-ring.md)
records the fresh load-image/function evidence and separately credited TH04
source and historical compiler replay. The figure illustrates the calculation;
original game assets and executable bytes are not website downloads.

## CTF case study

The DownUnderCTF 2023 case follows the official `ms_flag_checker` handout from
prompt references to checking functions, compressed masks, equations and an
accepted flag. [evidence/ctf-masked-squares.md](evidence/ctf-masked-squares.md)
records the REA analysis, extracted data and positive/negative process captures.
The downloadable `public/showcase/ctf/solve.py` uses Python and `z3-solver`;
its constants come from REA's byte reads. The original executable stays in the
organizers' repository and is linked from the page.

The mask SVG is drawn from the seventh decoded mask. It selects zero-based
position 21 and compares its character code with 55 (`7`). Keep the figure,
solver constants and evidence notes aligned when changing this case.

## GitHub Pages

`.github/workflows/website-pages.yml` prepares and deploys only `website/public`.
It is the sole Pages publisher, manually triggered and restricted to `main`;
ordinary pushes and pull requests do not publish the site.

Website checks run only for pull requests that change `website/`, the verification
script or workflow definitions. They check local links, HTML fragments, SVG XML
and the single Pages publisher without installing npm dependencies. The same
checks run before each manual deployment. You can also run them locally:

```sh
python3 scripts/prepare-website.py
python3 scripts/verify-website.py
```

`.github/workflows/pages.yml` is a separate, manual-only VitePress build. It
has no Pages artifact upload, deployment job or deployment permissions. This
prevents documentation updates from replacing the public website. The legacy
publishing job has been removed, so enabling this build workflow cannot publish
the old site.

After the site is approved and merged, select **GitHub Actions** under the
repository's **Settings → Pages → Build and deployment**. Then run **Publish REA
website** from the Actions tab on `main`. The workflow uses the `github-pages`
environment and the official Pages actions.

The equivalent CLI command is:

```sh
gh workflow run website-pages.yml --repo morluto/rea --ref main
```

Local development does not change Pages settings or run the deployment workflow.
Any environment protection rules are configured separately when publication is
approved.
