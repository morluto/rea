"""Check website references, search metadata and the sole production publisher."""

from html.parser import HTMLParser
from pathlib import Path
import re
import struct
import sys
from urllib.parse import quote, unquote, urlsplit
# nosemgrep: python.lang.security.use-defused-xml.use-defused-xml -- Expat 2.7.2+ is required before parsing; SVG input is capped at 8 MiB.
import xml.etree.ElementTree as ET  # nosemgrep: python.lang.security.use-defused-xml.use-defused-xml
from xml.parsers import expat  # nosemgrep: python.lang.security.use-defused-xml.use-defused-xml
from zipfile import BadZipFile, ZipFile

SVG_XML_MAX_BYTES = 8 * 1024 * 1024
MINIMUM_EXPAT_VERSION = (2, 7, 2)


SITE_ORIGIN = "https://rea.tools"
NOTES_FIXTURES = {"examples/notes-electron/index.html", "examples/notes-web/index.html"}


class HtmlReferences(HTMLParser):
    """Collect document IDs and references without fetching external URLs."""

    def __init__(self):
        super().__init__()
        self.ids = set()
        self.references = []
        self.duplicate_ids = []
        self.in_head = False
        self.in_title = False
        self.titles = []
        self.meta = {}
        self.properties = {}
        self.canonicals = []
        self.lang = None
        self.h1_count = 0

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "html":
            self.lang = attributes.get("lang")
        if tag == "h1":
            self.h1_count += 1
        if tag == "head":
            self.in_head = True
        if self.in_head:
            if tag == "title":
                self.titles.append("")
                self.in_title = True
            if (
                tag == "link"
                and "canonical" in (attributes.get("rel") or "").lower().split()
            ):
                self.canonicals.append(attributes.get("href") or "")
            if tag == "meta":
                for attribute, collection in (
                    ("name", self.meta),
                    ("property", self.properties),
                ):
                    key = attributes.get(attribute)
                    if key:
                        collection.setdefault(key.lower(), []).append(
                            attributes.get("content") or ""
                        )
        identifier = attributes.get("id")
        if identifier is not None:
            if identifier in self.ids:
                self.duplicate_ids.append(identifier)
            self.ids.add(identifier)
        for attribute in ("href", "src"):
            reference = attributes.get(attribute)
            if reference is not None:
                self.references.append(reference)

    def handle_endtag(self, tag):
        if tag == "head":
            self.in_head = False
        if tag == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.titles[-1] += data

    def noindex(self):
        """Recognize directives that exclude this page from Google's index."""
        directives = ",".join(
            self.meta.get("robots", []) + self.meta.get("googlebot", [])
        ).lower()
        return bool(set(re.split(r"[\s,]+", directives)) & {"noindex", "none"})


def check_search_metadata(site, pages):
    """Verify route-specific canonicals, sharing assets and the generated sitemap."""
    errors = []
    indexable = set()
    titles = set()
    for path, page in pages.items():
        label = path.relative_to(site).as_posix()
        title = page.titles[0].strip() if len(page.titles) == 1 else ""
        if not title:
            errors.append(f"{label}: needs exactly one nonempty head title")
        if page.lang != "en" or page.h1_count != 1:
            errors.append(f"{label}: needs lang=en and exactly one h1")
        if label in NOTES_FIXTURES and not page.noindex():
            errors.append(
                f"{label}: example application must have a head noindex directive"
            )
        if page.noindex():
            continue
        route = (
            path.relative_to(site).parent.as_posix()
            if path.name == "index.html"
            else label
        )
        route = "" if route == "." else route
        url = f"{SITE_ORIGIN}/{quote(route, safe='/')}" + (
            "/" if route and path.name == "index.html" else ""
        )
        indexable.add(url)
        if page.canonicals != [url]:
            errors.append(f"{label}: needs exactly one head canonical for {url}")
        if title in titles:
            errors.append(f"{label}: duplicate search title {title!r}")
        titles.add(title)
        descriptions = page.meta.get("description", [])
        description = descriptions[0].strip() if len(descriptions) == 1 else ""
        if not description:
            errors.append(f"{label}: needs exactly one nonempty head description")
        expected_og = {
            "og:type": "website",
            "og:site_name": "REA",
            "og:title": title,
            "og:description": description,
            "og:url": url,
            "og:image": f"{SITE_ORIGIN}/assets/social-card.png",
            "og:image:type": "image/png",
            "og:image:width": "1200",
            "og:image:height": "630",
        }
        expected_twitter = {
            "twitter:card": "summary_large_image",
            "twitter:title": title,
            "twitter:description": description,
            "twitter:image": expected_og["og:image"],
        }
        for collection, expected in (
            (page.properties, expected_og),
            (page.meta, expected_twitter),
        ):
            for key, value in expected.items():
                if collection.get(key) != [value]:
                    errors.append(
                        f"{label}: {key} must appear once and match {value!r}"
                    )
        for collection, key in (
            (page.properties, "og:image:alt"),
            (page.meta, "twitter:image:alt"),
        ):
            values = collection.get(key, [])
            if len(values) != 1 or not values[0].strip():
                errors.append(f"{label}: needs exactly one nonempty {key}")

    sitemap_path = site / "sitemap.xml"
    try:
        sitemap = ET.parse(sitemap_path).getroot()
        namespace = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
        urls = [entry.findtext(f"{namespace}loc") for entry in sitemap]
        if sitemap.tag != f"{namespace}urlset" or any(
            entry.tag != f"{namespace}url" for entry in sitemap
        ):
            errors.append("sitemap.xml: needs a sitemap-protocol urlset")
        if len(urls) != len(set(urls)) or set(urls) != indexable:
            errors.append(
                "sitemap.xml: must contain each indexable page once, using its rea.tools URL"
            )
        if any(
            len(entry) != 1 or entry[0].tag != f"{namespace}loc" for entry in sitemap
        ):
            errors.append(
                "sitemap.xml: keep entries to loc; do not invent lastmod or add priority/changefreq"
            )
    except (OSError, ET.ParseError) as error:
        errors.append(
            f"sitemap.xml: cannot read sitemap ({error}); run scripts/prepare-website.py"
        )

    robots_path = site / "robots.txt"
    if not robots_path.is_file():
        errors.append("robots.txt: authored crawl rules are missing")
    else:
        directives = []
        for line in robots_path.read_text(encoding="utf-8").splitlines():
            value = line.split("#", 1)[0].strip()
            if value:
                key, separator, content = value.partition(":")
                directives.append(
                    (key.lower(), content.strip()) if separator else (value, "")
                )
        expected = [
            ("user-agent", "*"),
            ("allow", "/"),
            ("sitemap", f"{SITE_ORIGIN}/sitemap.xml"),
        ]
        if directives != expected:
            errors.append(
                "robots.txt: expected crawl access and one absolute rea.tools sitemap directive"
            )

    image = site / "assets/social-card.png"
    if not image.is_file():
        errors.append("Social preview PNG is missing; run scripts/prepare-website.py")
    else:
        header = image.read_bytes()[:24]
        if (
            len(header) != 24
            or header[:16] != b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
            or struct.unpack(">II", header[16:24]) != (1200, 630)
        ):
            errors.append("Social preview must be a 1200 × 630 PNG")
    return len(indexable), errors


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
            elif (
                target in pages
                and url.fragment
                and unquote(url.fragment) not in pages[target].ids
            ):
                errors.append(f"{label}: missing HTML fragment: {reference}")

    if expat.version_info < MINIMUM_EXPAT_VERSION:
        errors.append(
            "SVG XML validation requires Expat 2.7.2 or newer; "
            f"found {expat.EXPAT_VERSION}. Use Python 3.14 or a patched Python build."
        )

    for path in sorted(site.rglob("*.svg")):
        if expat.version_info < MINIMUM_EXPAT_VERSION:
            break
        if path.stat().st_size > SVG_XML_MAX_BYTES:
            errors.append(
                f"{path.relative_to(site)}: SVG exceeds the {SVG_XML_MAX_BYTES}-byte XML parsing limit"
            )
            continue
        try:
            # Expat version is checked above; repository and pull-request SVGs are still untrusted input.
            ET.parse(path)  # nosemgrep: python.lang.security.use-defused-xml.use-defused-xml
        except ET.ParseError as error:
            errors.append(f"{path.relative_to(site)}: invalid SVG XML: {error}")
    indexable, metadata_errors = check_search_metadata(site, pages)
    errors.extend(metadata_errors)
    return len(pages), references, indexable, errors


def check_publisher(root):
    """Detect a second Pages action that could replace the website."""
    expected = root / ".github/workflows/website-pages.yml"
    workflows = root / ".github/workflows"
    deploy_action = re.compile(
        r"^\s*-?\s*uses:\s*['\"]?actions/deploy-pages@", re.MULTILINE
    )
    publishers = [
        path
        for path in sorted(workflows.iterdir())
        if path.suffix in (".yml", ".yaml")
        and deploy_action.search(path.read_text(encoding="utf-8"))
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
        for name in (
            "package.json",
            "main.js",
            "preload.js",
            "renderer.js",
            "csv.js",
            "index.html",
        )
    }
    path = site / "examples/notes-example.zip"
    if not path.is_file():
        return ["Notes example ZIP is missing; run python3 scripts/prepare-website.py."]
    try:
        with ZipFile(path) as archive:
            if sorted(archive.namelist()) != sorted(expected):
                return [
                    "Notes example ZIP must contain exactly the six files in notes-example/."
                ]
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
    pages, references, indexable, errors = check_site(root / "website/public")
    errors.extend(check_example_archive(root / "website/public"))
    errors.extend(check_publisher(root))
    if errors:
        print("Website checks failed:\n" + "\n".join(errors), file=sys.stderr)
        return 1
    print(
        f"Verified {pages} HTML pages, {references} local references, SVG XML and the example ZIP."
    )
    print(
        f"Verified search/sharing metadata, robots.txt and the sitemap for {indexable} indexable pages."
    )
    print("website-pages.yml is the sole GitHub Pages publisher.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
