"""Prepare downloads, the sitemap and the sharing image for the static website."""

from io import BytesIO
from pathlib import Path
import json
import sys
import xml.etree.ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from website import SOCIAL_FIGURES, SITE_ORIGIN, PageMetadata, page_url
from website_agents import prepare_discovery, prepare_markdown


EXAMPLE_FILES = (
    "package.json",
    "main.js",
    "preload.js",
    "renderer.js",
    "csv.js",
    "index.html",
)


def prepare_sitemap(site):
    """Discover HTML routes automatically, excluding pages marked noindex."""
    namespace = "http://www.sitemaps.org/schemas/sitemap/0.9"
    ET.register_namespace("", namespace)
    sitemap = ET.Element(f"{{{namespace}}}urlset")
    for path in sorted(site.rglob("*.html")):
        policy = PageMetadata()
        policy.feed(path.read_text(encoding="utf-8"))
        if policy.noindex:
            continue
        entry = ET.SubElement(sitemap, f"{{{namespace}}}url")
        ET.SubElement(
            entry, f"{{{namespace}}}loc"
        ).text = page_url(site, path)
    ET.indent(sitemap, space="  ")
    ET.ElementTree(sitemap).write(
        site / "sitemap.xml", encoding="utf-8", xml_declaration=True
    )
    print(f"Prepared sitemap.xml ({len(sitemap)} indexable pages).")


def prepare_images(site):
    """Render social previews and the conventional browser icon from their sources."""
    try:
        import cairosvg
    except (ImportError, OSError) as error:
        sys.exit(
            f"Cannot prepare sharing image: {error}. Install website/requirements.txt and native Cairo; see website/README.md."
        )
    from PIL import Image, ImageOps
    root = Path(__file__).resolve().parent.parent
    artwork = root / "website/artwork"

    def render(source, width):
        png = cairosvg.svg2png(url=str(source), output_width=width)
        with Image.open(BytesIO(png)) as image:
            return image.convert("RGBA")

    favicon = render(site / "assets/favicon.svg", 192)
    favicon.save(site / "favicon.ico", sizes=[(n, n) for n in (16, 32, 48, 64, 192)])

    with Image.open(artwork / "rea-social-preview.png") as original:
        default = ImageOps.fit(original.convert("RGB"), (1200, 630), method=Image.Resampling.LANCZOS)
        default.save(site / "assets/social-card.png", optimize=True)

    directory = site / "assets/share"
    directory.mkdir(exist_ok=True)
    for source in sorted(set(SOCIAL_FIGURES.values())):
        figure = ImageOps.contain(render(root / source, 1200), (1200, 630))
        card = Image.new("RGB", (1200, 630), "white")
        card.paste(figure, ((1200 - figure.width) // 2, (630 - figure.height) // 2), figure)
        card.save(directory / (Path(source).stem + ".png"), optimize=True)


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


def prepare_search_images(site):
    from bs4 import BeautifulSoup
    for path in site.rglob("*.html"):
        source = path.read_text(encoding="utf-8")
        head = BeautifulSoup(source.partition("</head>")[0], "html.parser")
        fields = {tag["property"]: tag["content"] for tag in head.select("meta[property][content]")}
        if "og:image" not in fields:
            continue
        url = fields["og:url"]
        data = {
            "@context": "https://schema.org", "@type": "WebPage", "url": url,
            "name": fields["og:title"], "inLanguage": head.html["lang"],
            "primaryImageOfPage": fields["og:image"],
        }
        if fields["og:type"] == "article":
            data["mainEntity"] = {
                "@type": "BlogPosting", "headline": fields["og:title"],
                "description": fields["og:description"], "image": fields["og:image"],
                "mainEntityOfPage": url,
            }
        payload = json.dumps(data, ensure_ascii=False).replace("<", "\\u003c")
        path.write_text(source.replace("</head>", f'<script type="application/ld+json">{payload}</script>\n  </head>', 1), encoding="utf-8")


def prepare_redirects(site):
    """Publish permanent Cloudflare redirects and equivalent static Pages links."""
    routes = {
        "showcases": ("showcase", "REA showcases"),
        "environments": ("guides/rl-environments", "Build RL environments"),
    }
    from bs4 import BeautifulSoup
    rules = []
    for alias, (target, title) in routes.items():
        rules.extend(f"/{alias}{suffix} /{target}/ 301" for suffix in ("", "/"))
        directory = site / alias
        directory.mkdir()
        destination = BeautifulSoup((site / target / "index.html").read_text(encoding="utf-8").partition("</head>")[0], "html.parser")
        sharing = "\n".join(str(tag) for tag in destination.select('meta[property^="og:"], meta[name^="twitter:"]'))
        directory.joinpath("index.html").write_text(
            f'<!doctype html><html lang="en"><head><meta charset="utf-8">\n'
            f'<title>{title}</title><meta name="robots" content="noindex">\n'
            f'<link rel="canonical" href="{SITE_ORIGIN}/{target}/">\n'
            f'{sharing}\n<meta http-equiv="refresh" content="0; url=../{target}/"></head>\n'
            f'<body><h1><a href="../{target}/">{title}</a></h1></body></html>\n',
            encoding="utf-8",
        )
    (site / "_redirects").write_text("\n".join(rules) + "\n", encoding="utf-8")


def prepare_assets(site):
    """Finish the shared publish artifact before it replaces the current preview."""
    from rcssmin import cssmin
    stylesheet = site / "assets/styles.css"
    stylesheet.write_text(cssmin(stylesheet.read_text(encoding="utf-8")), encoding="utf-8")
    prepare_search_images(site)
    prepare_redirects(site)
    prepare_images(site)
    prepare_sitemap(site)
    prepare_notes_example(site)
    prepare_discovery(Path(__file__).resolve().parent.parent, site)
    prepare_markdown(site)


if __name__ == "__main__":
    root = Path(__file__).resolve().parent.parent
    from website_i18n import build_translations
    build_translations(root, root / "website/_site", finalize=prepare_assets)
