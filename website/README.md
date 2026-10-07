# REA website

An English static website with explanatory figures, worked guides and a DX-Ball investigation.
The public files are in `website/public/`. The site uses HTML, CSS and a small
script for copying code and following the assembly-to-C comparison; it has no
build step or npm dependencies.

## Local preview

From the repository root:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory website/public
```

Open <http://127.0.0.1:4173/>. Refresh the browser after editing a file.

## Pages

- `public/index.html`: product introduction and DX-Ball overview.
- `public/showcase/dx-ball/index.html`: sound-pan investigation and project status.
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

Agent terminals show example prompts, not transcripts of previous
investigations. A short cursor animation starts when the prompt enters view and
respects reduced-motion preferences. All prompt text is present without JavaScript.

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

## GitHub Pages

`.github/workflows/website-pages.yml` prepares and deploys only `website/public`.
It is the sole Pages publisher, manually triggered and restricted to `main`;
ordinary pushes and pull requests do not publish the site.

Website checks run only for pull requests that change `website/`, the verification
script or workflow definitions. They check local links, HTML fragments, SVG XML
and the single Pages publisher without installing npm dependencies. The same
checks run before each manual deployment. You can also run them locally:

```sh
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
