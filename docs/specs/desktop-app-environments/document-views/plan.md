# Plan

1. Format and reader: `zip` detected by its local file header; the text, JSON,
   key file and XML readers shared as `textualView`, so a file and an entry
   read alike; a domain module for the entry limits, the entry view and the
   archive view, and an application reader that walks the verified bytes with
   zip.js under the options and name decoding `ZipArtifactReader` uses.
2. Selectors: `locatePointer` in `src/domain/desktop/viewPointer.ts`, used by
   REA's evaluator and the draft, and `_locate` in the exported verifier, with
   the same messages; `tolerance` in the task schema and both evaluators.
3. Changes and draft: member keys chosen per array from the candidate
   selectors of both versions, a keyed walk for zip views in `compareTrees`,
   and a walk that notes a member added or removed whole once for the draft's
   archive suggestions.
4. Exported module: `_zip` and `_entry_view` beside `_view`, with
   `zipfile`, `zlib` and `hashlib` imported at the top.
5. Docs and tests: real FreeCAD 0.21 and 1.0 `Document.xml` files zipped into
   `.FCStd` archives and checked by both evaluators, an `.odt` built in the
   test, archives crafted for each limit, and the shared check cases run
   through both evaluators.
6. Namespaced XML: the exported module reads XML with `expat` rather than
   `ElementTree`, one pass with namespace processing to check the document and
   one without to build the view as REA's DOM does, names and text nodes
   alike; the export's namespace refusal and the draft's namespace gate go.
   Parity tests read real Inkscape and LibreOffice Writer saves.
