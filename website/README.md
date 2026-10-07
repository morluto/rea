# REA website

An English static website with explanatory figures and a DX-Ball investigation.
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
- `public/assets/`: shared styles, interactions, favicon and explanatory figures.

Navigation and assets use relative paths, so the same files work at the local
root and a GitHub Pages project path such as `/rea/`.

## Content

Keep the copy direct and specific. Explain the task and the result before listing
tool names. Setup commands and runtime requirements should match the released
package.

DX-Ball figures and findings refer to the linked 7 October 2026 checkpoint,
commit `a55dca27ec0a07018c1b2c95ae2be027f7d8c3c4`. Update those links and figures
together when moving to another checkpoint. Case-study source excerpts come
from the MIT-licensed DX-Ball reconstruction repository.

The assembly excerpts were transcribed from the project's saved REA/Ghidra
Evidence. [evidence/dx-ball-sound-pan.md](evidence/dx-ball-sound-pan.md) records
their provenance and the scope of the validation claims. The original executable
and complete private Evidence records are not website assets.

Both raster figures were generated with the built-in image generation tool.
[figures.md](figures.md) retains their final prompts and review notes. Figures
provide an overview; assembly and C remain selectable HTML text. On narrow
screens, the diagrams scroll horizontally and can also be opened at full size.

## GitHub Pages

`.github/workflows/website-pages.yml` prepares and deploys only `website/public`.
It is manually triggered and restricted to `main`; ordinary pushes and pull
requests do not publish the site.

After the site is approved and merged, select **GitHub Actions** under the
repository's **Settings → Pages → Build and deployment**. Then run **Publish REA
website** from the Actions tab on `main`. The workflow uses the `github-pages`
environment and the official Pages actions.

Local development does not change Pages settings or run the deployment workflow.
Any environment protection rules are configured separately when publication is
approved.
