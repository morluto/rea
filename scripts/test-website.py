"""Exercise automatic route discovery and mistakes that break search metadata."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile
from threading import Thread
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import urlopen
import xml.etree.ElementTree as ET

import polib
from website_i18n import Document, build_translations, checked_catalog, extract_catalogs, languages, reading_pages, read_runtime


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
                shutil.copytree(ROOT / "website/_site", site)
                path = site / name
                source = path.read_text()
                self.assertIn(old, source)
                path.write_text(source.replace(old, new, 1))
                self.assertTrue(
                    any(message in error for error in VERIFY.check_site(site)[3])
                )
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory) / "public"
            shutil.copytree(ROOT / "website/_site", site)
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
            template = root / "website/templates/header.html.tmpl"
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
            WEBSITE.sync_pages(root)
            shutil.copyfile(ROOT / "website/_site/assets/social-card.png", site / "assets/social-card.png")
            PREPARE.prepare_notes_example(site)
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
            shutil.copytree(ROOT / "website/_site", site)
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


class WebsiteTranslationChecks(unittest.TestCase):
    """Exercise source edits, translated evidence and language editions at their consumers."""

    @contextlib.contextmanager
    def translated_project(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("public", "templates", "locales"):
                shutil.copytree(ROOT / "website" / name, root / "website" / name)
            inventory = [item for item in languages(ROOT) if item["code"] in {"en", "zh-CN", "ar"}]
            (root / "website/locales/languages.json").write_text(json.dumps(inventory))
            for item in inventory:
                destination = root / item["readme"]
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text("# REA\n")
            WEBSITE.sync_pages(root)
            extract_catalogs(root)
            yield root

    def test_source_change_preserves_review_and_excludes_stale_translation_from_search(self):
        with self.translated_project() as root:
            path = root / "website/locales/zh-CN/messages.po"
            catalog = polib.pofile(path)
            old = catalog.find("How do I install REA?", msgctxt="page:faq/index.html")
            old.tcomment = "Reviewed installation wording."
            old_translation = old.msgstr
            catalog.save(path)
            page = root / "website/public/faq/index.html"
            page.write_text(page.read_text().replace("How do I install REA?", "How do I install REA today?"))
            with self.assertRaisesRegex(ValueError, "Translation sources changed"):
                extract_catalogs(root, check=True)
            extract_catalogs(root)
            updated = polib.pofile(path)
            archived = next(entry for entry in updated if entry.obsolete and entry.msgid == old.msgid)
            self.assertEqual((archived.msgstr, archived.tcomment), (old_translation, old.tcomment))
            new = updated.find("How do I install REA today?", msgctxt=old.msgctxt)
            self.assertEqual(new.msgstr, "")
            build_translations(root, root / "website/_site")
            site = root / "website/_site"
            PREPARE.prepare_sitemap(site)
            fallback = VERIFY.HtmlReferences()
            fallback.feed((site / "zh-CN/faq/index.html").read_text())
            self.assertTrue(fallback.translation_fallback)
            self.assertTrue(fallback.noindex())
            self.assertEqual(fallback.lang, "en")
            self.assertNotIn("https://rea.tools/zh-CN/faq/", (site / "sitemap.xml").read_text())
            self.assertNotIn('hreflang="zh-CN"', (site / "faq/index.html").read_text())
            new.msgstr = "现在如何安装 REA？"
            new.flags.append("fuzzy")
            updated.save(path)
            build_translations(root, site)
            self.assertIn('data-translation-fallback="true"', (site / "zh-CN/faq/index.html").read_text())
            new.flags.remove("fuzzy")
            updated.save(path)
            build_translations(root, site)
            PREPARE.prepare_sitemap(site)
            result = (site / "zh-CN/faq/index.html").read_text()
            self.assertIn("现在如何安装 REA？", result)
            self.assertNotIn("data-translation-fallback", result)
            self.assertIn('href="../assets/styles.css"', (site / "zh-CN/index.html").read_text())
            self.assertIn('hreflang="zh-CN"', (site / "faq/index.html").read_text())
            self.assertIn("https://rea.tools/zh-CN/faq/", (site / "sitemap.xml").read_text())

    def test_broken_placeholders_and_inline_markup_fail_before_replacing_preview(self):
        with self.translated_project() as root:
            site = root / "website/_site"
            build_translations(root, site)
            before = (site / "zh-CN/index.html").read_bytes()
            path = root / "website/locales/zh-CN/messages.po"
            catalog = polib.pofile(path)
            entry = catalog.find("Already know RE? {ph0}Skip to analysis guides →{ph1}", msgctxt="page:index.html")
            original = entry.msgstr
            for bad, reason in (("丢失链接", "changed placeholders"), ("{ph1}错误的链接{ph0}", "invalid inline markup")):
                with self.subTest(reason=reason):
                    entry.msgstr = bad
                    catalog.save(path)
                    with self.assertRaisesRegex(ValueError, reason):
                        build_translations(root, site)
                    self.assertEqual((site / "zh-CN/index.html").read_bytes(), before)
            entry.msgstr = original
            catalog.save(path)
            (root / "website/locales/languages.json").unlink()
            with self.assertRaisesRegex(ValueError, "Missing languages.json"):
                build_translations(root, site)
            self.assertEqual((site / "zh-CN/index.html").read_bytes(), before)

    def test_runtime_message_drift_and_page_specific_completeness(self):
        with self.translated_project() as root:
            script = root / "website/public/assets/dino-demo.js"
            original = script.read_text()
            script.write_text(original.replace('t("Pause")', 't("Pause game")'))
            self.assertIn("Pause game", read_runtime(root))
            with self.assertRaisesRegex(ValueError, "Translation sources changed"):
                extract_catalogs(root, check=True)
            script.write_text(original.replace('t("Pause")', 't(dynamicMessage)'))
            with self.assertRaisesRegex(ValueError, "one literal message"):
                read_runtime(root)
            script.write_text(original)
            path = root / "website/locales/zh-CN/messages.po"
            catalog = polib.pofile(path)
            catalog.find("Pause", msgctxt="runtime").msgstr = ""
            catalog.save(path)
            site = root / "website/_site"
            build_translations(root, site)
            self.assertIn('data-translation-fallback="true"', (site / "zh-CN/examples/dino-lab/index.html").read_text())
            self.assertNotIn('data-translation-fallback="true"', (site / "zh-CN/faq/index.html").read_text())

    def test_all_readme_editions_preserve_code_targets_downloads_and_reciprocal_routes(self):
        site = ROOT / "website/_site"
        english_pages = reading_pages(ROOT / "website/public")
        for language in languages(ROOT):
            code = language["code"]
            for original in english_pages:
                relative = original.relative_to(ROOT / "website/public")
                path = site / relative if code == "en" else site / code / relative
                with self.subTest(language=code, page=str(relative)):
                    source = original.read_text()
                    translated = path.read_text()
                    def evidence(html):
                        doc = Document(html)
                        return sorted(doc.source[node.start:node.end] for node in doc.nodes if node.tag in {"pre", "code", "kbd"} or node.attrs.get("translate") == "no")
                    self.assertEqual(evidence(source), evidence(translated))
                    parser = VERIFY.HtmlReferences()
                    parser.feed(translated)
                    self.assertEqual(parser.lang, "en" if parser.translation_fallback else code)
                    if code != "en" and not parser.translation_fallback:
                        self.assertEqual(parser.direction, language["dir"])
                    if parser.translation_fallback:
                        self.assertTrue(parser.noindex())
                        self.assertNotIn(code, parser.alternates)
                    else:
                        self.assertEqual(parser.alternates[code], WEBSITE.page_url(site, path))
                    english = VERIFY.HtmlReferences()
                    english.feed((site / relative).read_text())
                    self.assertEqual(parser.alternates, english.alternates)
                    self.assertTrue(set(parser.copy_targets) <= parser.ids)
        for fixture in WEBSITE.NOTES_FIXTURES:
            self.assertEqual((site / fixture).read_bytes(), (ROOT / "website/public" / fixture).read_bytes())
        with ThreadingHTTPServer(("127.0.0.1", 0), WEBSITE.preview_handler(site, "/rea/")) as server:
            worker = Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                base = f"http://127.0.0.1:{server.server_port}/rea/"
                with urlopen(base + "ar/faq?test=1") as response:
                    self.assertEqual(response.url, base + "ar/faq/?test=1")
                    self.assertIn(b'lang="ar"', response.read())
                with urlopen(base + "assets/i18n.js") as response:
                    self.assertIn(b"export function t", response.read())
                with urlopen(base + "examples/notes-example.zip") as response:
                    self.assertEqual(response.read(), (site / "examples/notes-example.zip").read_bytes())
            finally:
                server.shutdown()
                worker.join()

    def test_every_reading_page_loads_theme_before_styles(self):
        site = ROOT / "website/_site"
        english_pages = reading_pages(ROOT / "website/public")
        self.assertTrue(english_pages)
        for language in languages(ROOT):
            code = language["code"]
            for original in english_pages:
                relative = original.relative_to(ROOT / "website/public")
                for path in {original, site / relative if code == "en" else site / code / relative}:
                    with self.subTest(language=code, page=str(path.relative_to(ROOT))):
                        doc = Document(path.read_text())
                        colors = [node for node in doc.nodes if node.tag == "meta" and node.attrs.get("name") == "theme-color"]
                        self.assertEqual(len(colors), 1)
                        self.assertEqual(colors[0].attrs.get("content"), "#ffffff")
                        self.assertNotIn("media", colors[0].attrs)
                        theme = [node for node in doc.nodes if node.tag == "script" and (node.attrs.get("src") or "").endswith("/assets/theme.js")]
                        self.assertEqual(len(theme), 1)
                        for deferred in ("defer", "async", "type"):
                            self.assertNotIn(deferred, theme[0].attrs)
                        stylesheet = next(node for node in doc.nodes if node.tag == "link" and node.attrs.get("rel") == "stylesheet")
                        self.assertLess(theme[0].start, stylesheet.start)
                        toggle = [node for node in doc.nodes if "data-theme-toggle" in node.attrs]
                        self.assertEqual(len(toggle), 1)
                        self.assertEqual(toggle[0].tag, "button")
                        self.assertIn("hidden", toggle[0].attrs)


if __name__ == "__main__":
    unittest.main()
