# LibreOffice Writer documents

Each `content.xml` is unchanged from an `.odt` file that a real LibreOffice
Writer saved: LibreOffice 24.2.7.2 on Ubuntu 24.04, from
`soffice --headless --convert-to odt`. An `.odt` file is a zip archive, and
`content.xml` is the entry that holds the document's text; it declares 35
namespace prefixes on its root and names every element and attribute with one,
as `text:p` and `text:style-name`.

`before` is a flyer with a `Title` paragraph `Summer Bake Sale`, a `Subtitle`
paragraph `Monday 17 November` and a body paragraph. `after` is the same flyer
once the date was changed to `Monday 24 November`, and nothing else. Tests zip
each file into an `.odt` archive with its `mimetype`.
