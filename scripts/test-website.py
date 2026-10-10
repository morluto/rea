"""Exercise automatic route discovery and mistakes that break search metadata."""

import contextlib
import importlib.util
import io
from pathlib import Path
import shutil
import tempfile
from threading import Thread
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import urlopen
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent.parent


def load_script(name):
    """Load a repository script without executing its command-line entrypoint."""
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PREPARE = load_script("prepare-website")
VERIFY = load_script("verify-website")
WEBSITE = load_script("website")


class WebsiteSearchChecks(unittest.TestCase):
    """Use authored pages and temporary fixtures to check the publishing boundary."""

    def test_sitemap_tracks_added_moved_removed_and_nonindexable_pages(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)

            def page(name, head="", body=""):
                path = site / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(f"<html><head>{head}</head><body>{body}</body></html>")
                return path

            page("index.html")
            nested = page("guides/new/index.html")
            page(
                "examples/fixture/index.html",
                '<meta name="robots" content="NOINDEX, follow">',
            )
            page("draft.html", '<meta name="googlebot" content="none">')
            page("code & notes.html")
            page("visible/index.html", body='<meta name="robots" content="noindex">')
            (site / "asset.json").write_text("{}")

            def urls():
                with contextlib.redirect_stdout(io.StringIO()):
                    PREPARE.prepare_sitemap(site)
                sitemap = ET.parse(site / "sitemap.xml")
                return {node.text for node in sitemap.findall(".//{*}loc")}

            self.assertEqual(
                urls(),
                {
                    "https://rea.tools/",
                    "https://rea.tools/guides/new/",
                    "https://rea.tools/code%20%26%20notes.html",
                    "https://rea.tools/visible/",
                },
            )
            nested.rename(site / "moved.html")
            self.assertIn("https://rea.tools/moved.html", urls())
            self.assertNotIn("https://rea.tools/guides/new/", urls())
            (site / "moved.html").unlink()
            self.assertNotIn("https://rea.tools/moved.html", urls())

    def test_verifier_rejects_wrong_canonicals_stale_sitemaps_and_missing_previews(
        self,
    ):
        cases = (
            (
                "index.html",
                'rel="canonical" href="https://rea.tools/"',
                'rel="canonical" href="https://morluto.github.io/rea/"',
                "head canonical",
            ),
            (
                "showcase/aegis/index.html",
                'rel="canonical" href="https://rea.tools/showcase/aegis/"',
                'rel="canonical" href="https://rea.tools/"',
                "head canonical",
            ),
            (
                "examples/notes-electron/index.html",
                'content="noindex"',
                'content="index"',
                "must have a head noindex",
            ),
            (
                "sitemap.xml",
                "https://rea.tools/faq/",
                "https://rea.tools/deleted/",
                "each indexable page once",
            ),
            (
                "faq/index.html",
                'name="twitter:card" content="summary_large_image"',
                'name="twitter:card" content="summary"',
                "twitter:card",
            ),
        )
        for name, old, new, message in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                site = Path(directory) / "public"
                shutil.copytree(ROOT / "website/public", site)
                path = site / name
                source = path.read_text()
                self.assertIn(old, source)
                path.write_text(source.replace(old, new, 1))
                self.assertTrue(
                    any(message in error for error in VERIFY.check_site(site)[3])
                )
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory) / "public"
            shutil.copytree(ROOT / "website/public", site)
            (site / "assets/social-card.png").unlink()
            self.assertIn(
                "Social preview PNG is missing; run scripts/prepare-website.py",
                VERIFY.check_site(site)[3],
            )


class WebsiteMaintenanceChecks(unittest.TestCase):
    """Exercise contributor edits and the static preview through real consumers."""

    def test_shared_edits_preserve_body_and_catch_drift_before_rewriting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("public", "templates"):
                shutil.copytree(ROOT / "website" / name, root / "website" / name)
            page = root / "website/public/blog/touhou-reconstruction/index.html"
            original = page.read_text()
            body = original.split('<main id="main"', 1)[1].split("</main>", 1)[0]
            template = root / "website/templates/header.html"
            template.write_text(template.read_text().replace("Reverse Engineer Anything", "REA test navigation"))
            with self.assertRaisesRegex(ValueError, "Shared HTML is stale"):
                WEBSITE.sync_pages(root, check=True)
            self.assertEqual(page.read_text(), original)
            WEBSITE.sync_pages(root)
            updated = page.read_text()
            self.assertIn("REA test navigation", updated)
            self.assertEqual(updated.split('<main id="main"', 1)[1].split("</main>", 1)[0], body)
            self.assertEqual(WEBSITE.sync_pages(root), [])
            page.write_text(updated.replace('    <!-- website:header:end -->', '', 1))
            with self.assertRaisesRegex(ValueError, "needs one header region"):
                WEBSITE.sync_pages(root)

    def test_new_page_escapes_metadata_stays_a_draft_and_joins_sitemap_when_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("public", "templates"):
                shutil.copytree(ROOT / "website" / name, root / "website" / name)
            site = root / "website/public"
            page = WEBSITE.new_page(root, "blog/new-example", 'A <test> & "result"', 'Check "quotes" & <markup>.')
            source = page.read_text()
            self.assertIn('href="../../blog/" aria-current="page"', source)
            self.assertIn('href="../../assets/styles.css"', source)
            self.assertIn("A &lt;test&gt; &amp; &quot;result&quot;", source)
            with self.assertRaisesRegex(ValueError, "Page already exists"):
                WEBSITE.new_page(root, "blog/new-example", "Another page", "Description")
            with self.assertRaises(ValueError):
                WEBSITE.new_page(root, "../outside", "Title", "Description")
            WEBSITE.sync_pages(root, check=True)
            PREPARE.prepare_sitemap(site)
            self.assertNotIn("https://rea.tools/blog/new-example/", (site / "sitemap.xml").read_text())
            page.write_text(source.replace('    <meta name="robots" content="noindex" />\n', ''))
            PREPARE.prepare_sitemap(site)
            self.assertIn("https://rea.tools/blog/new-example/", (site / "sitemap.xml").read_text())
            self.assertEqual(VERIFY.check_site(site)[3], [])

    def test_links_in_prompts_fragments_and_copy_controls_are_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory) / "public"
            shutil.copytree(ROOT / "website/public", site)
            page = site / "faq/index.html"
            original = page.read_text()
            cases = (
                ('<a href="https://rea.tools/deleted/">Broken</a>', "missing local target"),
                ('<code>https://rea.tools/guides/native/#deleted</code>', "missing HTML fragment"),
                ('<code>https://morluto.github.io/rea/examples/notes-web/</code>', "obsolete website URL"),
                ('<button data-copy="deleted">Copy</button>', "missing copy target"),
                ('<a href="https://[">Malformed</a>', "invalid URL"),
            )
            for inserted, message in cases:
                with self.subTest(message=message):
                    page.write_text(original.replace("</main>", inserted + "</main>", 1))
                    self.assertTrue(any(message in error for error in VERIFY.check_site(site)[3]))

    def test_repository_links_reject_missing_files_and_old_markdown_anchors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "website/public").mkdir(parents=True)
            (root / "docs").mkdir()
            (root / "docs/guide.md").write_text("# Guide\n## Set up REA\n")
            page = root / "website/README.md"
            page.write_text("[Guide](../docs/guide.md#set-up-rea)\n")
            (root / "website/.venv").mkdir()
            (root / "website/.venv/vendor.md").write_text("[File](missing.md)")
            self.assertEqual(VERIFY.check_repository_links(root), [])
            page.write_text("[Guide](../docs/guide.md#removed)\n[File](../docs/removed.md)\n")
            errors = VERIFY.check_repository_links(root)
            self.assertTrue(any("missing Markdown fragment" in error for error in errors))
            self.assertTrue(any("missing repository target" in error for error in errors))

    def test_preview_preserves_pages_prefix_for_assets_and_directory_redirects(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            (site / "guide").mkdir()
            (site / "guide/index.html").write_text("<h1>Guide</h1>")
            (site / "asset.css").write_text("body { color: black; }")
            for prefix in ("/", "/rea/"):
                with self.subTest(prefix=prefix), ThreadingHTTPServer(("127.0.0.1", 0), WEBSITE.preview_handler(site, prefix)) as server:
                    worker = Thread(target=server.serve_forever, daemon=True)
                    worker.start()
                    try:
                        base = f"http://127.0.0.1:{server.server_port}"
                        with urlopen(base + prefix + "guide?test=1") as response:
                            self.assertEqual(response.url, base + prefix + "guide/?test=1")
                            self.assertEqual(response.read(), b"<h1>Guide</h1>")
                        with urlopen(base + prefix + "asset.css") as response:
                            self.assertIn(b"color: black", response.read())
                        with self.assertRaises(HTTPError) as error:
                            urlopen(base + prefix + "missing")
                        self.assertEqual(error.exception.code, 404)
                        if prefix != "/":
                            with self.assertRaises(HTTPError) as error:
                                urlopen(base + "/guide/")
                            self.assertEqual(error.exception.code, 404)
                    finally:
                        server.shutdown()
                        worker.join()


if __name__ == "__main__":
    unittest.main()
