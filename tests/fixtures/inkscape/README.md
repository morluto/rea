# Inkscape drawings

Each `poster.svg` is unchanged from a file that a real Inkscape saved as
Inkscape SVG: Inkscape 1.2.2 on Ubuntu 24.04, from
`inkscape poster.svg --export-type=svg`. The saved file declares the default
SVG namespace, `svg`, `inkscape` and `sodipodi`, names the document with
`sodipodi:docname`, adds a `sodipodi:namedview` whose settings are `inkscape:`
attributes, and keeps `xml:space="preserve"` on its text.

`before` is an A4 poster with a layer `Layer 1` holding a banner and two
lines of text; the `text` with `id="headline"` reads `Spring Bake Sale`.
`after` is the same poster once the headline was changed to
`Summer Bake Sale`, and nothing else.
