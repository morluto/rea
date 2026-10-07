"""Check local website references and the sole GitHub Pages publisher."""

from html.parser import HTMLParser
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET
from zipfile import BadZipFile, ZipFile


class HtmlReferences(HTMLParser):
    """Collect document IDs and references without fetching external URLs."""

    def __init__(self):
        super().__init__()
        self.ids = set()
        self.references = []
        self.duplicate_ids = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        identifier = attributes.get("id")
        if identifier is not None:
            if identifier in self.ids:
                self.duplicate_ids.append(identifier)
            self.ids.add(identifier)
        for attribute in ("href", "src"):
            reference = attributes.get(attribute)
            if reference is not None:
                self.references.append(reference)


def check_site(site):
    """Check assets, HTML fragment destinations and SVG syntax."""
    pages = {}
    errors = []
    references = 0
    for path in sorted(site.rglob("*.html")):
        parser = HtmlReferences()
        parser.feed(path.read_text(encoding="utf-8"))
        pages[path] = parser
    if site / "index.html" not in pages:
        errors.append("website/public/index.html is missing")

    for path, page in pages.items():
        label = path.relative_to(site)
        for identifier in page.duplicate_ids:
            errors.append(f"{label}: duplicate ID {identifier!r}")
        for reference in page.references:
            url = urlsplit(reference)
            if url.scheme or url.netloc:
                continue
            references += 1
            if url.path.startswith("/"):
                errors.append(f"{label}: use a relative site reference: {reference}")
                continue
            target = (path.parent / unquote(url.path)).resolve() if url.path else path
            if not target.is_relative_to(site):
                errors.append(f"{label}: reference leaves the website: {reference}")
                continue
            if target.is_dir():
                target /= "index.html"
            if not target.is_file():
                errors.append(f"{label}: missing local target: {reference}")
            elif target in pages and url.fragment and unquote(url.fragment) not in pages[target].ids:
                errors.append(f"{label}: missing HTML fragment: {reference}")

    for path in sorted(site.rglob("*.svg")):
        try:
            ET.parse(path)
        except ET.ParseError as error:
            errors.append(f"{path.relative_to(site)}: invalid SVG XML: {error}")
    return len(pages), references, errors


def check_publisher(root):
    """Detect a second Pages action that could replace the website."""
    expected = root / ".github/workflows/website-pages.yml"
    workflows = root / ".github/workflows"
    deploy_action = re.compile(r"^\s*-?\s*uses:\s*['\"]?actions/deploy-pages@", re.MULTILINE)
    publishers = [
        path
        for path in sorted(workflows.iterdir())
        if path.suffix in (".yml", ".yaml") and deploy_action.search(path.read_text(encoding="utf-8"))
    ]
    if publishers != [expected]:
        actual = ", ".join(str(path.relative_to(root)) for path in publishers) or "none"
        return [f"Pages must have one publisher, website-pages.yml; found: {actual}"]
    return []


def check_example_archive(site):
    """Verify the downloadable ZIP contains the current six source files."""
    source = site / "examples/notes-electron"
    expected = {
        f"notes-example/{name}": source / name
        for name in ("package.json", "main.js", "preload.js", "renderer.js", "csv.js", "index.html")
    }
    path = site / "examples/notes-example.zip"
    if not path.is_file():
        return ["Notes example ZIP is missing; run python3 scripts/prepare-website.py."]
    try:
        with ZipFile(path) as archive:
            if sorted(archive.namelist()) != sorted(expected):
                return ["Notes example ZIP must contain exactly the six files in notes-example/."]
            return [
                f"Notes example ZIP has stale source: {name}"
                for name, original in expected.items()
                if archive.read(name) != original.read_bytes()
            ]
    except (BadZipFile, RuntimeError) as error:
        return [f"Notes example ZIP cannot be read: {error}"]


def main():
    """Run the same checks locally, on website PRs and before publishing."""
    root = Path(__file__).resolve().parent.parent
    pages, references, errors = check_site(root / "website/public")
    errors.extend(check_example_archive(root / "website/public"))
    errors.extend(check_publisher(root))
    if errors:
        print("Website checks failed:\n" + "\n".join(errors), file=sys.stderr)
        return 1
    print(f"Verified {pages} HTML pages, {references} local references, SVG XML and the example ZIP.")
    print("website-pages.yml is the sole GitHub Pages publisher.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
