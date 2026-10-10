# Website maintenance

> A good website is like a good paper: easy to follow, clear and concise, with a clean, refined presentation.
>
> — N0zoM1z0

Read [README.md](README.md) and [style-guide.md](style-guide.md) before changing
website content, layout or figures. Use [figures.md](figures.md) and `evidence/`
for asset notes and the source of case-study claims.

- Write English, direct headings and concrete instructions. Each paragraph
  should explain a new fact or action.
- Reuse the shared styles, prompts, figures and code-step components. Keep a
  case study focused on one question, with further examples in native details.
- Show what REA returns and how the agent uses it. Preserve source attribution,
  target identity and verification scope.
- Blog articles teach methods, decisions and workflows through concrete cases.
  Lead with the takeaway. Essays can develop a personal argument through
  experience; figures are optional and should add an explanation the prose
  needs. Use engine details only when they explain a decision. Label working
  outlines and mark them `noindex`.
- Keep personal paths, account data, credentials and raw captures outside the
  public assets. Use generic inputs and label shortened display paths.
- Follow the same clear writing standard in search titles and descriptions.
  Give each content page its own absolute `https://rea.tools/` canonical and
  matching sharing metadata; keep navigation relative. The sitemap is generated
  from HTML automatically. Mark example applications `noindex` in the head and
  keep them crawlable. Maintain the SVG sharing source, not the generated PNG.
- Check both local root and `/rea/` paths, mobile layouts, expanded details,
  copying and downloads. Run `scripts/prepare-website.py` followed by
  `scripts/verify-website.py` and `scripts/test-website.py`, using the website
  Python environment described in the README.
- Keep `website-pages.yml` as the sole, manual production publisher for
  Cloudflare and Pages. Default to `both`: both hosts receive the same verified
  artifact and pass the published-commit check. Use `pages` only when explicitly
  requested while Cloudflare credentials are being configured. Follow the
  website README.
