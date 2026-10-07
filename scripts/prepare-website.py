"""Package the public Notes example for the static website."""

from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


EXAMPLE_FILES = (
    "package.json",
    "main.js",
    "preload.js",
    "renderer.js",
    "csv.js",
    "index.html",
)


def prepare_notes_example(site):
    """Create a ZIP with public source only and reproducible metadata."""
    source = site / "examples/notes-electron"
    contents = BytesIO()
    with ZipFile(contents, "w") as archive:
        for name in EXAMPLE_FILES:
            entry = ZipInfo(f"notes-example/{name}", (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(
                entry,
                (source / name).read_bytes(),
                compress_type=ZIP_DEFLATED,
                compresslevel=9,
            )
    destination = site / "examples/notes-example.zip"
    destination.write_bytes(contents.getvalue())
    print(f"Prepared examples/notes-example.zip ({len(EXAMPLE_FILES)} files).")


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    prepare_notes_example(root / "website/public")
