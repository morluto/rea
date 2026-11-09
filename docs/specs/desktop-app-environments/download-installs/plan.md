# Plan

1. Shared install: `appDownloadInstall.ts` holds the download schema, the
   folder and file names, and the renderer of `install-download.sh` and a
   tarball's entry, which the build computer and the export both use.
2. Request: the `appimage` and `tarball` kinds in the build request, their
   `Download`, run script order (REA, `.deb`, download, Electron) and files.
3. Threading: the build capture passes the request's download to the export,
   which takes it as `--download-install` in a file it writes beside the
   task.
4. Export: the install decision for a download, its refusals, the class's
   `downloads` and `run`, the README and limitations, and the CLI flag.
5. Docs: the skill's install choice, the build computer and export guides.
6. Tests first: the bundle's declarations and order, the schema's refusals,
   both scripts run under `sh` against a stub AppImage and a real `.tar.xz`,
   the export's declarations, its script equal to the build's and its
   refusals, and the MCP build passing the download to the export. Then
   FreeCAD's AppImage, a tarball and draw.io's `.deb` on a real build host.
