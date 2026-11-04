# Plan

1. Schema: optional `apt_repositories`, `library_packages`,
   `missing_libraries`, `unpackaged_libraries` and `library_packages_reason`
   in the capture's package section.
2. Pure readers: apt sources (one-line and deb822), the source an
   `apt-cache policy` line comes from, apt's list file names, gpgv's VALIDSIG
   status and ASCII armor; ELF DT_NEEDED and RUNPATH/RPATH on the shared ELF
   header, program header, dynamic entry and string table readers; the
   `ldconfig -p` cache and the library walk with host reads injected.
3. Host adapters: an apt repository inventory that runs gpgv on private
   keyring copies, a library package inventory that reads ELF images through
   owned file handles and batches `dpkg-query -S`, and Debian package
   identification split out of the Linux inventory, with an injectable query
   runner and apt folders.
4. Capture: retain each verified key in the content store before the
   baseline; a key the content budget cannot hold is recorded as unverified.
5. Export: decide the install (archive, verified vendor repositories, or a
   refusal), copy keys from retained content, render `AptSource` and library
   packages, add `--no-sandbox` for Electron, and state each in the README
   and limitations.
6. Docs and tests: real-format fixtures from the Typora container for the
   parsers, fake query runners for the inventory, the export service for a
   vendor capture and its refusal, and a real Typora capture and export.
