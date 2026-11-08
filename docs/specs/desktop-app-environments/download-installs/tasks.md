# Tasks

Requirements are in [spec.md](spec.md#requirements); evidence is in
[verification.md](verification.md).

- [x] Record the outcome, requirements and non-goals.
- [x] Share the download schema, folder and file names and the
      `install-download.sh` renderer between the build computer and the export
      (Install).
- [x] Take `appimage` and `tarball` kinds in the build request, with their
      `Download`, run script order and files (Request, Build computer).
- [x] Pass the request's download from the build capture to the export as
      `--download-install` (Export).
- [x] Render the export's download, run script, tarball entry, refusals,
      README and limitations from it (Export, Refusals, README and
      limitations).
- [x] Document the install choice in the skill and the build computer and
      export guides.
- [x] Add tests that fail first, the scripts run under `sh` against a stub
      AppImage and a real `.tar.xz` ([Tests](verification.md#tests)).
- [x] Build and witness FreeCAD's AppImage, a VSCodium tarball and draw.io's
      `.deb` on an arm64 host ([verification](verification.md)).
- [x] Fix the review's findings: a URL that ended the docstring, an `env`
      prefix, links out of a tarball's folder, and `Exec` and `TryExec` keys
      spaced around their `=`.
- [x] Run the gates and record verification ([Gates](verification.md#gates)).
