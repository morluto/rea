"""Exercise automatic route discovery and mistakes that break search metadata."""

import contextlib
from html import unescape
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from textwrap import dedent
from threading import Thread
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import build_opener, ProxyHandler, urlopen
import xml.etree.ElementTree as ET

import polib
from website_i18n import Document, build_translations, checked_catalog, extract_catalogs, languages, prose_units, reading_pages, read_runtime


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
AUDIT = load_script("audit-website-links")


class WebsiteLinkAuditChecks(unittest.TestCase):
    """Check GitHub transport and URL classification without live network access."""

    def test_github_json_is_decoded_as_utf8_under_a_legacy_locale(self):
        # Exercise real subprocess pipe decoding with UTF-8 mode disabled. Only
        # the external gh executable and the default locale are substituted.
        program = dedent('''\
            import importlib.util
            import json
            from pathlib import Path
            import subprocess
            import sys
            from unittest.mock import patch

            scripts = Path(sys.argv[1])
            sys.path.insert(0, str(scripts))
            spec = importlib.util.spec_from_file_location("audit", scripts / "audit-website-links.py")
            audit = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(audit)
            payload = json.dumps({"title": "Release \\u2603"}, ensure_ascii=False).encode("utf-8")
            run = subprocess.run

            def gh(command, **options):
                assert command == ["gh", "api", "repos/example/project"]
                return run([sys.executable, "-c", "import sys; sys.stdout.buffer.write(" + repr(payload) + ")"], **options)

            with patch("locale.getencoding", return_value="cp936"), patch.object(audit.subprocess, "run", side_effect=gh):
                print(json.dumps(audit.github_api("repos/example/project")))
        ''')
        result = subprocess.run(
            [sys.executable, "-X", "utf8=0", "-c", program, str(ROOT / "scripts")],
            capture_output=True, encoding="utf-8", timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"title": "Release \u2603"})

    def test_raw_and_browser_links_resolve_the_same_ref_and_encoded_path(self):
        # Prefix lookalikes must not win, and tags use the same ref/path split.
        references = {
            "repos/example/project/git/matching-refs/heads/topic": [
                {"ref": "refs/heads/topic"},
                {"ref": "refs/heads/topic/nested"},
                {"ref": "refs/heads/topic/nestedness"},
            ],
            "repos/example/project/git/matching-refs/tags/topic": [
                {"ref": "refs/tags/topic/nested/v1"},
            ],
            "repos/example/project/git/matching-refs/heads/topic%2Fnested": [
                {"ref": "refs/heads/topic/nested"},
                {"ref": "refs/heads/topic/nestedness"},
            ],
            "repos/example/project/git/matching-refs/tags/topic%2Fnested": [
                {"ref": "refs/tags/topic/nested/v1"},
            ],
        }
        cases = (
            ("topic/nested/guide%20%23%3F.md", "guide%20%23%3F.md", "topic%2Fnested"),
            ("topic/nested/v1/README.md", "README.md", "topic%2Fnested%2Fv1"),
            ("topic%2Fnested/README.md", "README.md", "topic%2Fnested"),
            ("refs/heads/topic/nested/v1/README.md", "v1/README.md", "refs%2Fheads%2Ftopic%2Fnested"),
            ("refs/tags/topic/nested/v1/README.md", "README.md", "refs%2Ftags%2Ftopic%2Fnested%2Fv1"),
        )
        for suffix, path, ref in cases:
            endpoint = f"repos/example/project/contents/{path}?ref={ref}"
            responses = {**references, endpoint: {"name": "README.md"}}

            def github_api(target):
                if target not in responses:
                    raise ValueError("gh: Not Found (HTTP 404)")
                return responses[target]

            for base in (
                "https://raw.githubusercontent.com/example/project/",
                "https://github.com/example/project/blob/",
                "https://github.com/example/project/tree/",
            ):
                with self.subTest(url=base + suffix), patch.object(AUDIT, "github_api", side_effect=github_api):
                    report = AUDIT.audit_url((base + suffix, ["fixture.html"]))
                    self.assertEqual(report["status"], "ok")
                    self.assertEqual(report["endpoint"], endpoint)

    def test_repeated_link_checks_do_not_mutate_cached_github_refs(self):
        heads = [{"ref": "refs/heads/topic"}]
        tags = [{"ref": "refs/tags/topic/nested"}]
        ref_endpoint = "repos/example/project/git/matching-refs/"
        responses = {
            ref_endpoint + "heads/topic": heads,
            ref_endpoint + "tags/topic": tags,
        }
        with patch.object(AUDIT, "github_api", side_effect=responses.__getitem__):
            for file in ("README.md", "guide.md", "examples/a.md"):
                url = urlsplit(f"https://github.com/example/project/blob/topic/nested/{file}")
                self.assertEqual(
                    AUDIT.github_target(url).endpoint,
                    f"repos/example/project/contents/{file}?ref=topic%2Fnested",
                )
        self.assertEqual(heads, [{"ref": "refs/heads/topic"}])
        self.assertEqual(tags, [{"ref": "refs/tags/topic/nested"}])

    def test_release_routes_check_the_requested_tag_and_asset(self):
        cases = (
            ('tag/series/v1', 'tags/series%2Fv1', 'ok'),
            ('download/series/v1/tool%20kit.zip', 'tags/series%2Fv1', 'ok'),
            ('download/series%2Fv1/absent.zip', 'tags/series%2Fv1', 'broken'),
            ('latest', 'latest', 'ok'),
            ('latest/download/tool%20kit.zip', 'latest', 'ok'),
            ('latest/download/absent.zip', 'latest', 'broken'),
            ('latest/%64ownload/absent.zip', 'latest', 'broken'),
            ('%64ownload/series/v1/absent.zip', 'tags/series%2Fv1', 'broken'),
            ('latest/%64ownload/tool%20kit.zip', 'latest', 'ok'),
        )
        for route, endpoint, status in cases:
            with self.subTest(route=route), patch.object(AUDIT, 'github_api', return_value={'assets': [{'name': 'tool kit.zip'}]}) as request:
                url = 'https://github.com/example/project/releases/' + route
                report = AUDIT.audit_url((url, ['fixture.html']))
                self.assertEqual(report['status'], status)
                request.assert_called_once_with('repos/example/project/releases/' + endpoint)

    def test_plain_refs_and_pinned_commits_keep_their_contents_target(self):
        for ref in ("main", "a" * 40):
            responses = {
                "repos/example/project/git/matching-refs/heads/main": [{"ref": "refs/heads/main"}],
                "repos/example/project/git/matching-refs/tags/main": [],
                f"repos/example/project/contents/README.md?ref={ref}": {"name": "README.md"},
            }
            for base in ("https://raw.githubusercontent.com/example/project/", "https://github.com/example/project/blob/"):
                with self.subTest(ref=ref, base=base), patch.object(AUDIT, "github_api", side_effect=responses.__getitem__):
                    report = AUDIT.audit_url((base + ref + "/README.md", ["fixture.html"]))
                    self.assertEqual(report["status"], "ok")
                    self.assertEqual(report["endpoint"], f"repos/example/project/contents/README.md?ref={ref}")

    def test_raw_github_urls_distinguish_repository_files_from_other_routes(self):
        ref = "a" * 40
        responses = {
            f"repos/example/project/contents/scripts?ref={ref}": [{"name": "tool.py", "type": "file"}],
            f"repos/example/project/contents/vendor/library?ref={ref}": {
                "type": "file", "submodule_git_url": "https://github.com/example/library.git",
            },
            "repos/example/project/git/matching-refs/heads/releases": [{"ref": "refs/heads/releases"}],
            "repos/example/project/git/matching-refs/tags/releases": [],
            "repos/example/project/contents/download/packages/tool.zip?ref=releases": {"type": "file"},
            "repos/example/project/releases/tags/v1": {"assets": [{"name": "tool.zip"}]},
        }
        cases = (
            (f"https://raw.githubusercontent.com/example/project/{ref}/scripts", "broken"),
            (f"https://github.com/example/project/tree/{ref}/scripts", "ok"),
            (f"https://raw.githubusercontent.com/example/project/{ref}/vendor/library", "broken"),
            (f"https://github.com/example/project/tree/{ref}/vendor/library", "ok"),
            ("https://raw.githubusercontent.com/example/project/releases/download/packages/tool.zip", "ok"),
            ("https://github.com/example/project/releases/download/v1/tool.zip", "ok"),
            ("https://github.com/example/project/releases/download/v1/missing.zip", "broken"),
            ("https://raw.githubusercontent.com/example/project", "broken"),
        )
        with patch.object(AUDIT, "github_api", side_effect=responses.__getitem__):
            for url, expected in cases:
                with self.subTest(url=url):
                    self.assertEqual(AUDIT.audit_url((url, ["fixture.html"]))["status"], expected)

    def test_malformed_external_links_do_not_hide_other_audit_results(self):
        invalid = (
            "https://[::1/guide",
            "https://github.com:bad/example/project",
            "https:///no-host",
            "http://bad host.invalid/guide",
            "http://example.invalid/not escaped",
        )
        valid = "https://github.com/example/project"
        html = "website/public/index.html"
        markdown = "website/guide.md"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            page = root / html
            page.parent.mkdir(parents=True)
            page.write_text("".join(f'<a href="{url}">Link</a>' for url in (*invalid, valid, "https://rea.tools/")))
            (root / markdown).write_text(f"[Guide]({invalid[0]})")
            opener = build_opener(ProxyHandler({}))
            with (
                patch.object(AUDIT, "github_api", return_value={"name": "project"}) as probe,
                patch.object(AUDIT, "urlopen", opener.open),
            ):
                reports = {
                    report["url"]: report
                    for item in AUDIT.external_links(root).items()
                    if (report := AUDIT.audit_url(item)) is not None
                }

        probe.assert_called_once_with("repos/example/project")
        self.assertEqual(set(reports), {*invalid, valid})
        self.assertEqual(reports[valid]["status"], "ok")
        for index, url in enumerate(invalid):
            with self.subTest(url=url):
                self.assertEqual(reports[url]["status"], "broken")
                self.assertEqual(reports[url]["sources"], sorted([html, markdown] if index == 0 else [html]))
                self.assertIn("Invalid URL", reports[url]["reason"])

    def test_markdown_destinations_reach_both_link_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "website").mkdir()
            (root / "docs").mkdir()
            (root / "docs/releases(v1).md").write_text("# Release notes\n")
            source = root / "website/guide.md"
            source.write_text(dedent('''\
                [Release](../docs/releases(v1).md#release-notes)
                [Upstream][ref]
                [Malformed](https:/missing-authority)
                [IPv6](https://[::1/guide)
                <https://example.invalid/docs(1)>
                <img src="HTTPS://example.invalid/figure(1).png">

                `[Code example](https://example.invalid/ignore-inline)`

                ```md
                [Code example](../missing.md)
                [Code example](https://example.invalid/ignore-fenced)
                ```

                [ref]: HTTPS://example.invalid/release(v1)
            '''))
            self.assertCountEqual(AUDIT.external_links(root), [
                "HTTPS://example.invalid/release(v1)", "https:/missing-authority",
                "https://[::1/guide", "https://example.invalid/docs(1)",
                "HTTPS://example.invalid/figure(1).png",
            ])
            errors = VERIFY.check_repository_links(root)
            self.assertEqual(len(errors), 2)
            for malformed in ("https:/missing-authority", "https://[::1/guide"):
                self.assertTrue(any(f"website/guide.md: invalid URL '{malformed}'" in error for error in errors))

    def test_missing_contents_and_unavailable_github_probes_remain_distinct(self):
        cases = (
            (ValueError("gh: Not Found (HTTP 404)"), "broken"),
            (ValueError("gh: Forbidden (HTTP 403)"), "unknown"),
            (subprocess.TimeoutExpired(["gh", "api"], 20), "unknown"),
        )
        for failure, status in cases:
            for base in ("https://raw.githubusercontent.com/example/project/", "https://github.com/example/project/blob/"):
                with self.subTest(failure=str(failure), base=base), patch.object(AUDIT, "github_api", side_effect=failure):
                    report = AUDIT.audit_url((base + "a" * 40 + "/missing.md", ["fixture.html"]))
                    self.assertEqual(report["status"], status)
                    self.assertEqual(report["reason"], str(failure))


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
            moved = urls()
            self.assertIn("https://rea.tools/moved.html", moved)
            self.assertNotIn("https://rea.tools/guides/new/", moved)
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
                "needs exactly one head canonical",
            ),
            (
                "faq/index.html",
                'hreflang="zh-CN" href="https://rea.tools/zh-CN/faq/"',
                'hreflang="zh-CN" href="https://[::1/faq/"',
                "invalid hreflang URL",
            ),
            (
                "showcase/aegis/index.html",
                'rel="canonical" href="https://rea.tools/showcase/aegis/"',
                'rel="canonical" href="https://rea.tools/"',
                "needs exactly one head canonical",
            ),
            (
                "sitemap.xml",
                "https://rea.tools/faq/",
                "https://rea.tools/deleted/",
                "must contain each indexable page once",
            ),
            (
                "faq/index.html",
                'name="twitter:card" content="summary_large_image"',
                'name="twitter:card" content="summary"',
                "twitter:card",
            ),
        )
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory) / "public"
            shutil.copytree(ROOT / "website/_site", site)
            for name, old, new, _ in cases:
                path = site / name
                source = path.read_text()
                self.assertIn(old, source)
                path.write_text(source.replace(old, new, 1))
            (site / "assets/social-card.png").unlink()
            diagnostics = "\n".join(VERIFY.check_site(site)[3])
            for name, _, _, message in cases:
                with self.subTest(name=name, message=message):
                    self.assertIn(f"{name}: {message}", diagnostics)
            self.assertIn("Social preview PNG is missing", diagnostics)

            # Changing the indexable set would also invalidate the sitemap.
            example = site / "examples/notes-electron/index.html"
            source = example.read_text()
            self.assertIn('content="noindex"', source)
            example.write_text(source.replace('content="noindex"', 'content="index"', 1))
            self.assertIn(f"{example.relative_to(site).as_posix()}: example application must have a head noindex directive", VERIFY.check_site(site)[3])


class WebsiteMaintenanceChecks(unittest.TestCase):
    """Exercise contributor edits and the static preview through real consumers."""

    def test_electron_guide_renderer_matches_download(self):
        public = ROOT / "website/public"
        source = (public / "guides/javascript/index.html").read_text(encoding="utf-8")
        document = Document(source)
        blocks = [node for node in document.nodes if node.attrs.get("id") == "notes-renderer-source"]
        self.assertEqual(len(blocks), 1)
        self.assertEqual(blocks[0].tag, "code")
        displayed = unescape(source[blocks[0].open_end:blocks[0].end_start]) + "\n"
        self.assertEqual(displayed, (public / "examples/notes-electron/renderer.js").read_text(encoding="utf-8"))

    def test_contributors_render_from_snapshot_and_reject_drift_without_rewriting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("public", "templates"):
                shutil.copytree(ROOT / "website" / name, root / "website" / name)
            page = root / "website/public/contributors/index.html"
            snapshot = root / "website/public/contributors/people.json"
            data = json.loads(snapshot.read_text())
            people = data["contributors"][:3]
            for person, name, commits in zip(people, ("Zulu", "beta", "Amber"), (1, 4, 4)):
                person.update(login=name, html_url=f"https://github.com/{name}", commits=commits)
            data["contributors"] = people
            data["updated"] = "2026-10-15"
            snapshot.write_text(json.dumps(data))
            original = page.read_text()
            with self.assertRaisesRegex(ValueError, "Shared HTML is stale"):
                WEBSITE.sync_pages(root, check=True)
            self.assertEqual(page.read_text(), original)
            WEBSITE.sync_pages(root)
            source = page.read_text()
            doc = Document(source)
            cards = [node for node in doc.nodes if "data-contributor" in node.attrs]
            self.assertEqual([node.attrs["data-contributor"] for node in cards], ["Amber", "beta", "Zulu"])
            links = [node.attrs["href"] for node in doc.nodes if node.attrs.get("class") == "contributor-card"]
            self.assertCountEqual(links, [person["html_url"] for person in people])
            self.assertEqual(WEBSITE.sync_pages(root), [])
            translated_units = [unit[1] for unit in prose_units(source, "contributors/index.html")]
            for person in people:
                self.assertFalse(any(person["login"] in unit for unit in translated_units))

    def test_commit_authors_from_both_sources_are_credited_once_per_commit(self):
        people = json.loads((ROOT / "website/public/contributors/people.json").read_text())["contributors"][:3]
        a, b, c = ({k: v for k, v in person.items() if k != "commits"} for person in people)
        revision = "a" * 40
        primary = [{"sha": "first", "author": a}, {"sha": "second", "author": c}]
        commits = subprocess.CompletedProcess([], 0, stdout="\n".join(map(json.dumps, primary)))

        def page(sha, authors):
            commit = {"oid": sha, "authors": {"totalCount": len(authors), "nodes": [{"user": p} for p in authors]}}
            return {"data": {"repository": {"object": {"history": {"nodes": [commit]}}}}}

        pages = [page("first", [a, b]), page("second", [None, b])]
        with patch.object(WEBSITE, "github_json", side_effect=[{"object": {"sha": revision}}, pages]), \
                patch.object(WEBSITE.subprocess, "run", return_value=commits):
            data = WEBSITE.collect_contributors()
        self.assertEqual(data["revision"], revision)
        self.assertEqual({p["id"]: p["commits"] for p in data["contributors"]}, {
            a["id"]: 1, b["id"]: 2, c["id"]: 1,
        })
        with patch.object(WEBSITE, "github_json", side_effect=[{"object": {"sha": revision}}, pages[:1]]), \
                patch.object(WEBSITE.subprocess, "run", return_value=commits):
            with self.assertRaisesRegex(ValueError, "Incomplete GitHub commit history"):
                WEBSITE.collect_contributors()

    def test_failed_refresh_preserves_the_directory_and_readme_grid(self):
        data = json.loads((ROOT / "website/public/contributors/people.json").read_text())
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            snapshot = root / "website/public/contributors/people.json"
            snapshot.parent.mkdir(parents=True)
            grid = snapshot.with_name("avatars.png")
            snapshot.write_bytes(b"old snapshot")
            grid.write_bytes(b"old grid")
            replace = Path.replace

            def fail_snapshot(source, dest):
                if dest == snapshot:
                    raise PermissionError("snapshot unavailable")
                return replace(source, dest)

            with patch.object(WEBSITE, "collect_contributors", return_value=data), \
                    patch("website_contributor_grid.write_avatar_grid", side_effect=lambda people, path: path.write_bytes(b"new grid")), \
                    patch.object(Path, "replace", fail_snapshot):
                with self.assertRaises(PermissionError):
                    WEBSITE.refresh_contributors(root)
            self.assertEqual(snapshot.read_bytes(), b"old snapshot")
            self.assertEqual(grid.read_bytes(), b"old grid")
            self.assertEqual(set(snapshot.parent.iterdir()), {snapshot, grid})

    def test_contributor_snapshot_rejects_malformed_identity_and_unsafe_links(self):
        original = json.loads((ROOT / "website/public/contributors/people.json").read_text())
        for field, value in (("commits", 0), ("id", True), ("id", 0), ("login", ""), ("type", "unknown"),
                             ("html_url", "javascript:alert(1)"), ("html_url", "https://github.com.evil.test/person"),
                             ("avatar_url", "https://token@avatars.githubusercontent.com/u/1")):
            with self.subTest(field=field, value=value):
                data = {**original, "contributors": [{**original["contributors"][0], field: value}]}
                with self.assertRaises(ValueError):
                    WEBSITE.checked_contributors(data)

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
            shutil.copytree(ROOT / "website/_site/assets/share", site / "assets/share")
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
                ('<a href="https://rea.tools/deleted/">Broken</a>', "missing local target: https://rea.tools/deleted/"),
                ('<code>https://rea.tools/guides/native/#deleted</code>', "missing HTML fragment: https://rea.tools/guides/native/#deleted"),
                ('<code>https://morluto.github.io/rea/examples/notes-web/</code>', "obsolete website URL: https://morluto.github.io/rea/examples/notes-web/"),
                ('<button data-copy="deleted">Copy</button>', "missing copy target: deleted"),
                ('<a href="https://[">Malformed</a>', "invalid URL 'https://[':"),
            )
            inserted = "".join(html for html, _ in cases)
            page.write_text(original.replace("</main>", inserted + "</main>", 1))
            diagnostics = "\n".join(VERIFY.check_site(site)[3])
            for _, message in cases:
                with self.subTest(message=message):
                    self.assertIn(f"{page.relative_to(site)}: {message}", diagnostics)

    def test_repository_fragments_use_rendered_headings_and_html_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "website").mkdir()
            (root / "docs").mkdir()
            (root / "docs/guide.md").write_text(dedent("""\
                ---
                title: Guide
                ---

                ````markdown
                ```
                # Example heading
                <span id="example-id"></span>
                ```
                ````

                Guide heading
                -------------

                ## Read [the guide](another-guide.md) with `rea`

                ## ![Caf&eacute; *crème*](badge.svg)

                <p id="block-id">A block anchor.</p>

                An <span id="inline-id">inline anchor</span>.
            """), encoding="utf-8")
            (root / "docs/rule.md").write_text("---\nOrdinary heading\n---\n", encoding="utf-8")
            page = root / "website/README.md"
            page.write_text(dedent("""\
                ---
                description: "[Metadata](../docs/not-a-link.md)"
                ---

                [Setext](../docs/guide.md#guide-heading)
                [Leading rule](../docs/rule.md#ordinary-heading)
                [Formatted](../docs/guide.md#read-the-guide-with-rea)
                [Image alt text](../docs/guide.md#caf%C3%A9-cr%C3%A8me)
                [Block ID](../docs/guide.md#block-id)
                [Inline ID](../docs/guide.md#inline-id)
                [Metadata title](../docs/guide.md#title-guide)
                [Fenced heading](../docs/guide.md#example-heading)
                [Fenced ID](../docs/guide.md#example-id)
            """), encoding="utf-8")

            source = page.relative_to(root)
            self.assertEqual(VERIFY.check_repository_links(root), [
                f"{source}: missing Markdown fragment: ../docs/guide.md#title-guide",
                f"{source}: missing Markdown fragment: ../docs/guide.md#example-heading",
                f"{source}: missing Markdown fragment: ../docs/guide.md#example-id",
            ])

    def test_repository_links_preserve_targets_and_containment_through_aliased_roots(self):
        with tempfile.TemporaryDirectory() as directory:
            container = Path(directory)
            root = container / "repository"
            (root / "website/public").mkdir(parents=True)
            (root / "docs").mkdir()
            (root / "docs/guide.md").write_text("# Guide\n## Set up REA\n")
            (container / "outside.md").write_text("# Outside\n")
            page = root / "website/README.md"
            page.write_text("[Guide](../docs/guide.md#set-up-rea)\n")
            (root / "website/.venv").mkdir()
            (root / "website/.venv/vendor.md").write_text("[File](missing.md)")
            self.assertEqual(VERIFY.check_repository_links(root), [])
            alias = container / "repository-alias"
            alias.symlink_to(root.resolve(), target_is_directory=True)
            self.assertEqual(VERIFY.check_repository_links(alias), [])
            page.write_text(
                "[Guide](../docs/guide.md#removed)\n"
                "[File](../docs/removed.md)\n"
                "[Escape](../../outside.md)\n"
            )
            for boundary in (root, alias):
                with self.subTest(boundary=boundary):
                    self.assertCountEqual(VERIFY.check_repository_links(boundary), [
                        "website/README.md: missing Markdown fragment: ../docs/guide.md#removed",
                        "website/README.md: missing repository target: ../docs/removed.md",
                        "website/README.md: missing repository target: ../../outside.md",
                    ])

    def test_site_links_preserve_containment_through_aliased_roots(self):
        with tempfile.TemporaryDirectory() as directory:
            site = (Path(directory) / "site").resolve()
            site.mkdir()
            page = site / "index.html"
            page.write_text('<html lang="en"><head><title>Fixture</title><meta name="robots" content="noindex"></head><body><h1>Fixture</h1><a href="guide.html#answer">Guide</a></body></html>')
            (site / "guide.html").write_text('<html lang="en"><head><title>Guide</title><meta name="robots" content="noindex"></head><body><h1 id="answer">Answer</h1></body></html>')
            (site / "sitemap.xml").write_text('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>')
            (site / "robots.txt").write_text("User-agent: *\nAllow: /\nSitemap: https://rea.tools/sitemap.xml\n")
            alias = Path(directory) / "site-alias"
            alias.symlink_to(site, target_is_directory=True)
            # The tiny link fixture intentionally omits the social preview.
            expected = ["Social preview PNG is missing: assets/social-card.png; run scripts/prepare-website.py"]
            self.assertEqual(VERIFY.check_site(site)[3], expected)
            self.assertEqual(VERIFY.check_site(alias)[3], expected)
            (site.parent / "outside.html").write_text("<p>Outside</p>")
            content = page.read_text()
            for reference in ("../outside.html", "https://rea.tools/../outside.html"):
                page.write_text(content.replace("guide.html#answer", reference))
                for boundary in (site, alias):
                    with self.subTest(boundary=boundary, reference=reference):
                        self.assertIn(f"index.html: reference leaves the website: {reference}", VERIFY.check_site(boundary)[3])

    def test_preview_preserves_pages_prefix_for_assets_and_directory_redirects(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            (site / "guide").mkdir()
            (site / "guide/index.html").write_text("<h1>Guide</h1>")
            (site / "asset.css").write_text("body { color: black; }")
            comment = b"\xff\x80\r\n"
            archive = bytes.fromhex("504b0506" + "00" * 16) + len(comment).to_bytes(2, "little") + comment
            (site / "download.zip").write_bytes(archive)
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
                        with urlopen(base + prefix + "download.zip") as response:
                            self.assertEqual(response.read(), archive)
                        with self.assertRaises(HTTPError) as error:
                            urlopen(base + prefix + "missing")
                        with contextlib.closing(error.exception) as response:
                            self.assertEqual(response.code, 404)
                        if prefix != "/":
                            with self.assertRaises(HTTPError) as error:
                                urlopen(base + "/guide/")
                            with contextlib.closing(error.exception) as response:
                                self.assertEqual(response.code, 404)
                    finally:
                        server.shutdown()
                        worker.join()


class WebsiteTranslationChecks(unittest.TestCase):
    """Exercise source edits, translated evidence and language editions at their consumers."""

    def test_translation_keeps_malformed_references_for_the_verifier(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copytree(ROOT / "website/templates", root / "website/templates")
            locales = root / "website/locales"
            locales.mkdir()
            inventory = [item for item in languages(ROOT) if item["code"] in {"en", "zh-CN", "ar"}]
            (locales / "languages.json").write_text(json.dumps(inventory))
            page = WEBSITE.new_page(root, "guide", "Fixture", "Fixture guide.")
            bad_links = ("https://[::1/guide", "https://[::1/figure", "https://[::1/script")
            source = page.read_text().replace('    <meta name="robots" content="noindex" />\n', "")
            source = source.replace("</main>", f'<a href="{bad_links[0]}">Broken</a><img src="{bad_links[1]}" alt=""></main>')
            page.write_text(source.replace("</body>", f'<script src="{bad_links[2]}"></script></body>'))
            WEBSITE.sync_pages(root)
            extract_catalogs(root)
            catalog_path = locales / "zh-CN/messages.po"
            catalog = polib.pofile(catalog_path)
            for entry in catalog:
                entry.msgstr = entry.msgid
            catalog.save(catalog_path)

            output = root / "website/_site"
            build_translations(root, output)
            diagnostics = VERIFY.check_site(output)[3]
            for published in ("guide/index.html", "zh-CN/guide/index.html", "ar/guide/index.html"):
                for link in bad_links:
                    with self.subTest(published=published, link=link):
                        self.assertTrue(any(f"{published}: invalid URL '{link}'" in error for error in diagnostics))

    def test_language_switcher_preserves_encoded_paths_under_both_site_prefixes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copytree(ROOT / "website/templates", root / "website/templates")
            locales = root / "website/locales"
            locales.mkdir()
            shutil.copyfile(ROOT / "website/locales/languages.json", locales / "languages.json")
            route = "guides/Notes #1?%23 café"
            path = WEBSITE.new_page(root, route, "Fixture", "Fixture guide.")
            path.write_text(path.read_text().replace('    <meta name="robots" content="noindex" />\n', ""))
            WEBSITE.sync_pages(root)

            nodes = Document(path.read_text()).nodes
            canonical, = [node.attrs["href"] for node in nodes if node.attrs.get("rel") == "canonical"]
            picker = next(node for node in nodes if node.attrs.get("data-language") == "zh-CN")
            alternate = next(node for node in nodes if node.attrs.get("hreflang") == "zh-CN")
            encoded = "guides/Notes%20%231%3F%2523%20caf%C3%A9/"
            self.assertEqual(canonical, "https://rea.tools/" + encoded)
            self.assertEqual(alternate.attrs["href"], "https://rea.tools/zh-CN/" + encoded)
            for prefix in ("/", "/rea/"):
                with self.subTest(prefix=prefix):
                    base = "https://example.com" + prefix
                    self.assertEqual(urljoin(base + encoded, picker.attrs["href"]), base + "zh-CN/" + encoded)

    def test_language_inventory_preserves_script_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "website/locales").mkdir(parents=True)
            for code in ("ur", "ur-PK", "ur-Latn", "ur-Latn-PK", "hi-Latn"):
                inventory = [
                    {"code": "en", "name": "English", "readme": "README.md", "dir": "ltr"},
                    {"code": code, "name": "Fixture", "readme": f"docs/readme/README_{code}.md", "dir": "ltr"},
                ]
                path = root / "website/locales/languages.json"
                path.write_text(json.dumps(inventory))
                with self.subTest(code=code):
                    self.assertEqual(languages(root), inventory)
            for code in ("ur-latn", "ur-LATN", "ur-PK-Latn", "ur/Latn"):
                inventory[1]["code"] = code
                path.write_text(json.dumps(inventory))
                with self.subTest(code=code), self.assertRaisesRegex(ValueError, "Invalid or duplicate language"):
                    languages(root)

    def test_completed_script_tag_pages_pass_search_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            # check_site canonicalizes its root before collecting page keys.
            site = Path(directory).resolve()
            (site / "assets").mkdir()
            shutil.copyfile(ROOT / "website/_site/assets/social-card.png", site / "assets/social-card.png")
            shutil.copyfile(ROOT / "website/public/robots.txt", site / "robots.txt")
            pages = {}
            for code in ("ur-Latn", "ur-Latn-PK"):
                path = site / code / "index.html"
                path.parent.mkdir()
                url = f"https://rea.tools/{code}/"
                source = dedent(f'''\
                    <!doctype html>
                    <html lang="{code}" dir="ltr">
                    <head>
                      <title>REA ka ta'aruf</title>
                      <meta name="description" content="REA ko samjhein." />
                      <link rel="canonical" href="{url}" />
                      <link rel="alternate" hreflang="{code}" href="{url}" />
                      <meta property="og:type" content="website" />
                      <meta property="og:site_name" content="REA" />
                      <meta property="og:title" content="REA ka ta'aruf" />
                      <meta property="og:description" content="REA ko samjhein." />
                      <meta property="og:url" content="{url}" />
                      <meta property="og:image" content="https://rea.tools/assets/social-card.png" />
                      <meta property="og:image:type" content="image/png" />
                      <meta property="og:image:width" content="1200" />
                      <meta property="og:image:height" content="630" />
                      <meta property="og:image:alt" content="REA" />
                      <meta name="twitter:card" content="summary_large_image" />
                      <meta name="twitter:title" content="REA ka ta'aruf" />
                      <meta name="twitter:description" content="REA ko samjhein." />
                      <meta name="twitter:image" content="https://rea.tools/assets/social-card.png" />
                      <meta name="twitter:image:alt" content="REA" />
                    </head>
                    <body><h1>REA ka ta'aruf</h1></body>
                    </html>
                ''')
                path.write_text(source, encoding="utf-8")
                page = VERIFY.HtmlReferences()
                page.feed(source)
                self.assertFalse(page.translation_fallback)
                self.assertFalse(page.noindex())
                pages[path] = page
            PREPARE.prepare_sitemap(site)
            self.assertEqual(VERIFY.check_search_metadata(site, pages), (2, []))

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
            page = root / "website/public/index.html"
            page.write_text(page.read_text().replace(
                "</main>",
                '<p>Translation test <a href="get-started/">read more</a>.</p></main>',
            ))
            extract_catalogs(root)
            path = root / "website/locales/zh-CN/messages.po"
            catalog = polib.pofile(path)
            entry = catalog.find("Translation test {ph0}read more{ph1}.", msgctxt="page:index.html")
            self.assertIsNotNone(entry)
            entry.msgstr = "翻译测试：{ph0}继续阅读{ph1}。"
            catalog.save(path)
            site = root / "website/_site"
            build_translations(root, site)
            before = (site / "zh-CN/index.html").read_bytes()
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
                    font_stylesheets = [
                        node.attrs["href"] for node in Document(translated).nodes
                        if node.tag == "link" and node.attrs.get("rel") == "stylesheet"
                        and urlsplit(node.attrs.get("href", "")).netloc == "fonts.googleapis.com"
                    ]
                    self.assertEqual(len(font_stylesheets), int(parser.lang == "ko"))
                    if font_stylesheets:
                        self.assertIn("family=Noto+Sans+KR:wght@100..900", font_stylesheets[0])
                        self.assertIn("&display=swap", font_stylesheets[0])
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
        runtime = "assets/i18n.js"
        self.assertEqual((site / runtime).read_bytes(), (ROOT / "website/public" / runtime).read_bytes())
        arabic = VERIFY.HtmlReferences()
        arabic.feed((site / "ar/faq/index.html").read_text())
        self.assertEqual(arabic.lang, "ar")

    def test_reading_pages_set_the_initial_theme_and_defer_external_scripts(self):
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
                        scripts = [node for node in doc.nodes if node.tag == "script"]
                        for node in scripts:
                            if node.attrs.get("src"):
                                self.assertTrue("defer" in node.attrs or "async" in node.attrs or node.attrs.get("type") == "module")
                        stylesheet = next(node for node in doc.nodes if node.tag == "link" and node.attrs.get("rel") == "stylesheet")
                        self.assertTrue(any(node.start < stylesheet.start and "src" not in node.attrs and "type" not in node.attrs for node in scripts))
                        toggle = [node for node in doc.nodes if "data-theme-toggle" in node.attrs]
                        self.assertEqual(len(toggle), 1)
                        self.assertEqual(toggle[0].tag, "button")
                        self.assertIn("hidden", toggle[0].attrs)


if __name__ == "__main__":
    unittest.main()
