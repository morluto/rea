# AbiWord documents

Each `meeting.abw` is synthetic: written by hand in the form AbiWord 3.0
saves its native format, AWML 1.1, not saved by a real AbiWord. Like a real
save it is XML that starts with a `DOCTYPE` naming the AWML DTD by public and
system identifier, with no internal subset, keeps `xml:space="preserve"` on its
`abiword` root, and writes a paragraph as a `p` element numbered by `xid`.

`before` holds a planning note whose paragraph `xid="3"` reads
`The team meeting starts at 2:00 in room 4.` `after` is the same note once the
time was changed to `3:30` after the document was reopened: AbiWord wraps text
typed into a reopened document in `c` elements carrying the typing language,
so the paragraph's text is split across its children as
`The team meeting starts at <c>3</c>:<c>30</c> in room 4.` The save also
updates the metadata date and adds a `history` version.
