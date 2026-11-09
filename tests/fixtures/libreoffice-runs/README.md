# LibreOffice Writer paragraphs split into runs

Each `content.xml` is synthetic: the real LibreOffice 24.2 save in
[`../libreoffice/after`](../libreoffice/README.md), with its body paragraph
rewritten by hand in the form Writer saves text edited while it records
revision IDs (its default). Writer gives text typed in one editing session an
automatic text style, here `T1`, carrying that session's `officeooo:rsid`, and
writes each stretch of it as a `text:span`, so one paragraph's text is split
across several children.

`before` has the body paragraph `Cakes, biscuits and bread from 10:00 in the
school hall.` with no automatic styles. `after` is the flyer once the time was
changed to `9:30` and the place to `village green`, each word typed over in
the same session: `9`, `30`, `village` and `green` are spans of `T1`, and the
`:` and the space between `village` and `green` stay plain text of the
paragraph.
