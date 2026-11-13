# Plan

1. Pure modules: format detection and views (text, JSON, key file, XML),
   kinds of change per format, and roles from reasons.
2. Readers: dconf through a private file profile, SQLite through the shared
   SQLite service with the database and its log staged together.
3. Service: admit the capture Evidence, list paths and versions, read
   verified content, and build the Evidence.
4. CLI: `inspect-desktop-application-state`, composing the readers.
5. Docs: a user page and links.
6. Tests: parsers, changes and roles; the service on a synthetic capture with
   fake readers; Mousepad and a SQLite-editing script end to end on Linux.
