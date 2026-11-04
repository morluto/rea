# Plan

1. Schema: optional `apt_repositories` (each with its entry, architecture
   restriction, release and key), `library_packages`,
   `uninstallable_library_packages`, `missing_libraries`,
   `unpackaged_libraries` and `library_packages_reason` in the capture's
   package section.
2. Pure readers: apt sources (one-line and deb822, with apt's entry
   positions), `apt-get indextargets` output, apt's list file names, gpgv's
   status and ASCII armor, an OpenPGP packet splitter that fingerprints each
   transferable key; ELF DT_NEEDED and RUNPATH/RPATH on the shared ELF
   header, program header, dynamic entry and string table readers; the
   `ldconfig -p` cache, `apt-cache policy` for several packages, and the
   library walk with host reads injected.
3. Host adapters: an apt repository inventory that matches sources through
   `apt-get indextargets` and runs gpgv on private keyring copies whose folder
   is released through `ArtifactResourceScope`, a library package inventory
   that reads ELF images through owned file handles and batches
   `dpkg-query -S` and `apt-cache policy`, and Debian package identification
   split out of the Linux inventory, with an injectable query runner and apt
   folders.
4. Capture: retain each verified key in the content store before the
   baseline; a key over `--max-file-bytes` or the content budget is recorded
   as unverified.
5. Export: decide the install (archive, usable vendor repositories, or a
   refusal), copy keys from retained content, render `AptSource` once per URI
   and suite, the package as `<package>/<release>`, the host's architecture
   and library packages, add `--no-sandbox` for Electron, and state each in
   the README and limitations.
6. Docs and tests: real-format fixtures from the Typora container for the
   parsers, fake query runners for the inventory, the export service for a
   vendor capture and its refusal, and a real Typora capture and export.
