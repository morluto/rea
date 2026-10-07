# Website maintenance

Read [README.md](README.md) and [style-guide.md](style-guide.md) before changing
website content, layout or figures. Use [figures.md](figures.md) and `evidence/`
for asset notes and the source of case-study claims.

- Write English, direct headings and concrete instructions. Each paragraph
  should explain a new fact or action.
- Reuse the shared styles, prompts, figures and code-step components. Keep a
  case study focused on one question, with further examples in native details.
- Show what REA returns and how the agent uses it. Preserve source attribution,
  target identity and verification scope.
- Keep personal paths, account data, credentials and raw captures outside the
  public assets. Use generic inputs and label shortened display paths.
- Check both local root and `/rea/` paths, mobile layouts, expanded details,
  copying and downloads. Run `scripts/prepare-website.py` followed by
  `scripts/verify-website.py`.
- Keep `website-pages.yml` as the sole, manual Pages publisher. Follow the
  publication procedure in the website README.
