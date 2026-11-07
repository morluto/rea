# Civic Atlas

A locally editable, static recreation of the U.S. government graph dashboard at
`https://graph.civlab.org/us`. The starter records are an illustrative subset,
not an authoritative or complete government directory. The 482 organization and
339 sub-agency figures are reference-site totals; leadership counts only include
records you add to this workspace.

## Run locally

From the repository root:

```powershell
py -m http.server 8000 --directory examples\civlab-graph
```

Open <http://localhost:8000>. If `py` is unavailable, use
`python -m http.server 8000 --directory examples\civlab-graph`.

The app is plain HTML, CSS, and JavaScript and can also be hosted as a static
site. Workspace changes stay in the browser's local storage. Use **Export JSON**
for a backup or to move a workspace, and **Import JSON** to restore one.
