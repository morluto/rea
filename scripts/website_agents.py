"""Build public agent discovery and Markdown from their maintained sources."""

import hashlib
import json
from urllib.parse import urljoin
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from bs4 import BeautifulSoup
from markdownify import MarkdownConverter
import yaml

from website import NOTES_FIXTURES, PageMetadata, SITE_ORIGIN, page_url


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def prepare_discovery(root, site):
    """Publish the complete skill, including its relative reference documents."""
    source = root / ".agents/skills/reverse-engineer-anything"
    skill = (source / "SKILL.md").read_text(encoding="utf-8")
    if not skill.startswith("---\n") or "\n---\n" not in skill[4:]:
        raise ValueError("Public REA skill needs YAML frontmatter")
    metadata = yaml.safe_load(skill[4:].split("\n---\n", 1)[0])
    if not isinstance(metadata, dict):
        raise ValueError("Public REA skill needs YAML metadata")
    name, description = metadata["name"], metadata["description"]
    if name != source.name or not isinstance(description, str) or not description.strip():
        raise ValueError("Invalid public REA skill metadata")
    discovery = site / ".well-known/agent-skills"
    discovery.mkdir(parents=True, exist_ok=True)
    artifact = discovery / f"{name}.zip"
    with ZipFile(artifact, "w") as archive:
        for path in [source / "SKILL.md", *sorted(source.glob("references/**/*.md"))]:
            relative = path.relative_to(source)
            entry = ZipInfo(f"{name}/{relative.as_posix()}", (1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, path.read_bytes(), compress_type=ZIP_DEFLATED)
    artifact_url = f"{SITE_ORIGIN}/.well-known/agent-skills/{artifact.name}"
    write_json(discovery / "index.json", {
        "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
        "skills": [{
            "name": name, "type": "archive", "description": description,
            "url": artifact_url,
            "digest": "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest(),
        }],
    })
    entry = {
        "identifier": f"urn:air:rea.tools:skill:{name}",
        "displayName": "REA reverse engineering skill",
        "description": description,
        "type": "application/zip",
        "url": artifact_url,
    }
    write_json(site / ".well-known/ai-catalog.json", {
        "specVersion": "1.0",
        "host": {"displayName": "REA", "documentationUrl": f"{SITE_ORIGIN}/get-started/"},
        "entries": [entry],
    })
    write_json(site / ".well-known/ard.json", {"entries": [{
        **entry,
        "representativeQueries": [
            "Explain how a feature works in a shipped executable using REA.",
            "Trace an Electron application's behavior back to its packaged JavaScript.",
            "Build an AgentEnv bundle from a web application capture.",
        ],
    }]})
    print("Prepared agent skill archive, discovery index, AI Catalog and ARD manifest.")


def prepare_markdown(site):
    """Convert rendered reading pages, keeping code and resolving resource URLs."""
    converter = MarkdownConverter(heading_style="ATX", bullets="-", escape_underscores=False)
    count = 0
    for path in sorted(site.rglob("*.html")):
        if path.relative_to(site).as_posix() in NOTES_FIXTURES:
            continue
        source = path.read_text(encoding="utf-8")
        metadata = PageMetadata()
        metadata.feed(source)
        # Drafts and English fallbacks keep their HTML indexing policy intact.
        if metadata.noindex:
            continue
        soup = BeautifulSoup(source, "html.parser")
        main = soup.find("main")
        if main is None:
            continue
        # Preserve fallback notices and closed disclosures; remove interface chrome.
        for node in main.select('script, style, nav, button, svg, .home-page-nav, [aria-hidden="true"]'):
            if node.parent is not None:
                node.decompose()
        # These spans are separate lines in the shared flow component's CSS.
        for node in main.select("span.flow-label, span.flow-node, span.flow-note"):
            node.name = "div"
        canonical = page_url(site, path)
        for node in main.select("[href], [src]"):
            for attribute in ("href", "src"):
                if node.has_attr(attribute):
                    node[attribute] = urljoin(canonical, node[attribute])
        title = metadata.titles[0] if metadata.titles else "REA"
        header = yaml.safe_dump({"title": title, "url": canonical}, allow_unicode=True, sort_keys=False)
        markdown = converter.convert_soup(main).strip()
        path.with_suffix(".md").write_text(f"---\n{header}---\n\n{markdown}\n", encoding="utf-8")
        alternate = page_url(site, path.with_suffix(".md"))
        links = (
            f'<link rel="alternate" type="text/markdown" href="{alternate}" />\n'
            f'<link rel="ard" type="application/json" href="{SITE_ORIGIN}/.well-known/ard.json" />\n'
            f'<link rel="ai-catalog" type="application/ai-catalog+json" href="{SITE_ORIGIN}/.well-known/ai-catalog.json" />\n'
            f'<link rel="related" type="application/json" title="Agent skills index" href="{SITE_ORIGIN}/.well-known/agent-skills/index.json" />\n'
        )
        path.write_text(source.replace("</head>", links + "</head>", 1), encoding="utf-8")
        count += 1
    print(f"Prepared Markdown for {count} reading pages.")
