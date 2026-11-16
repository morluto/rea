"""Check the public build artifacts and Markdown content contract."""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile

from bs4 import BeautifulSoup
import yaml

from website_agents import prepare_discovery, prepare_markdown


ROOT = Path(__file__).resolve().parent.parent


class AgentPublishingChecks(unittest.TestCase):
    def test_published_skill_digest_covers_every_reference_and_catalogs_resolve(self):
        site = ROOT / "website/_site"
        index = json.loads((site / ".well-known/agent-skills/index.json").read_text())
        self.assertEqual(index["$schema"], "https://schemas.agentskills.io/discovery/0.2.0/schema.json")
        skill, = index["skills"]
        self.assertEqual(skill["name"], "reverse-engineer-anything")
        self.assertEqual(skill["type"], "archive")
        artifact = site / skill["url"].removeprefix("https://rea.tools/")
        self.assertEqual(skill["digest"], "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest())
        source = ROOT / ".agents/skills/reverse-engineer-anything"
        with ZipFile(artifact) as archive:
            expected = {f"{source.name}/{p.relative_to(source).as_posix()}": p.read_bytes()
                        for p in source.rglob("*.md")}
            self.assertEqual(set(archive.namelist()), set(expected))
            for name, data in expected.items():
                self.assertEqual(archive.read(name), data)
            manifest = archive.read(f"{source.name}/SKILL.md").decode()
            metadata = yaml.safe_load(manifest[4:].split("\n---\n", 1)[0])
            self.assertEqual(skill["description"], metadata["description"])
        catalog = json.loads((site / ".well-known/ai-catalog.json").read_text())
        self.assertEqual(catalog["specVersion"], "1.0")
        entry, = catalog["entries"]
        self.assertEqual(entry["identifier"], "urn:air:rea.tools:skill:reverse-engineer-anything")
        self.assertEqual(entry["url"], skill["url"])
        self.assertNotIn("data", entry)
        ard = json.loads((site / ".well-known/ard.json").read_text())
        resource, = ard["entries"]
        self.assertEqual(resource["url"], skill["url"])
        self.assertTrue(2 <= len(resource["representativeQueries"]) <= 5)

    def test_reference_changes_invalidate_digest_and_yaml_scalars_are_parsed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / ".agents/skills/reverse-engineer-anything"
            source.mkdir(parents=True)
            (source / "SKILL.md").write_text(
                '---\nname: reverse-engineer-anything\ndescription: >-\n  Inspect programs:\n  preserve evidence.\n---\n# REA\n'
            )
            (source / "references").mkdir()
            reference = source / "references/evidence.md"
            reference.write_text("First revision")
            site = root / "site"
            def build():
                prepare_discovery(root, site)
                return json.loads((site / ".well-known/agent-skills/index.json").read_text())["skills"][0]
            before = build()
            self.assertEqual(before["description"], "Inspect programs: preserve evidence.")
            self.assertEqual(build(), before)
            reference.write_text("Second revision")
            self.assertNotEqual(build()["digest"], before["digest"])

    def test_markdown_preserves_content_and_resources_without_publishing_excluded_pages(self):
        with tempfile.TemporaryDirectory() as directory:
            site = Path(directory)
            page = site / "zh-CN/guides/test/index.html"
            page.parent.mkdir(parents=True)
            page.write_text('''<html><head><title>REA: test</title></head><body>
              <nav>Outside navigation</nav><main><aside>Shortened display paths.</aside>
              <h1>Inspect a program</h1><nav>Contents navigation</nav>
              <ol><li><span class="flow-label">Read</span><span class="flow-node"><code>input.exe</code></span><span class="flow-note">Keep evidence.</span></li></ol>
              <p><a href="../other/?q=a%2Fb#code">Another guide</a></p>
              <pre><code>const value = a &lt; b ? "x_y" : "&amp;";\n  keepIndent();</code></pre>
              <details><summary>Evidence</summary><p>Hidden evidence remains available.</p></details>
              <img src="../../../assets/diagram.svg" alt="Investigation diagram">
              <button>Copy code</button><script>doNotPublish()</script></main></body></html>''')
            fixture = site / "examples/notes-web/index.html"
            fixture.parent.mkdir(parents=True)
            fixture.write_text("<main>Target application</main>")
            fallback = site / "zh-CN/fallback/index.html"
            fallback.parent.mkdir(parents=True)
            fallback.write_text('<head><meta name="robots" content="noindex, follow"></head><main>English fallback notice.</main>')
            prepare_markdown(site)
            markdown = page.with_suffix(".md").read_text()
            self.assertIn('# Inspect a program', markdown)
            self.assertIn('const value = a < b ? "x_y" : "&";\n  keepIndent();', markdown)
            self.assertIn("Hidden evidence remains available.", markdown)
            self.assertIn("Shortened display paths.", markdown)
            self.assertNotIn("Read`input.exe`", markdown)
            self.assertIn("https://rea.tools/zh-CN/guides/other/?q=a%2Fb#code", markdown)
            self.assertIn("https://rea.tools/assets/diagram.svg", markdown)
            for text in ("Outside navigation", "Contents navigation", "Copy code", "doNotPublish"):
                self.assertNotIn(text, markdown)
            self.assertFalse(fixture.with_suffix(".md").exists())
            self.assertFalse(fallback.with_suffix(".md").exists())
            html = BeautifulSoup(page.read_text(), "html.parser")
            self.assertEqual(html.find("link", rel="alternate")["href"], "https://rea.tools/zh-CN/guides/test/index.md")


if __name__ == "__main__":
    unittest.main()
