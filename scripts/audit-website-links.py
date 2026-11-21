"""Optionally audit external website links; network failures stay distinct from missing targets."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from http.client import InvalidURL
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import NamedTuple
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote
from urllib.request import Request, urlopen

from website import authored_markdown
from website_references import html_references, markdown_references, split_reference


@lru_cache(maxsize=None)
def github_api(endpoint):
    """Read GitHub evidence through the caller's gh installation and authentication."""
    result = subprocess.run(["gh", "api", endpoint], capture_output=True, encoding="utf-8", timeout=20)
    if result.returncode:
        raise ValueError(result.stderr.strip())
    return json.loads(result.stdout)


class InvalidLink(ValueError):
    """The authored URL cannot identify a target."""


class GitHubTarget(NamedTuple):
    endpoint: str
    raw_file: bool = False
    release_asset: str | None = None


def github_contents(repo, parts, raw_file=False):
    """Resolve the ref and source path shared by raw, blob and tree URLs."""
    namespace = None
    if len(parts) >= 2 and parts[0] == "refs" and parts[1] in ("heads", "tags"):
        namespace = parts[1]
        parts = parts[2:]
    if not parts or (raw_file and len(parts) < 2):
        if raw_file:
            raise InvalidLink("Raw GitHub URL needs a file path")
        return None
    ref = parts[0]
    suffix = "/".join(parts)
    if namespace or not re.fullmatch(r"[0-9a-f]{40}", ref):
        # GitHub uses the longest matching ref before the source path.
        scopes = (namespace,) if namespace else ("heads", "tags")
        matches = []
        for scope in scopes:
            for item in github_api(f"{repo}/git/matching-refs/{scope}/{quote(ref, safe='')}"):
                name = item["ref"].removeprefix(f"refs/{scope}/")
                if suffix == name or suffix.startswith(name + "/"):
                    matches.append(name)
        if matches:
            ref = max(matches, key=len)
    path = suffix[len(ref):].removeprefix("/")
    if raw_file and not path:
        raise InvalidLink("Raw GitHub URL needs a file path")
    if namespace:
        ref = f"refs/{namespace}/{ref}"
    endpoint = f"{repo}/contents/{quote(path, safe='/')}?ref={quote(ref, safe='')}"
    return GitHubTarget(endpoint, raw_file=raw_file)


def github_target(url):
    """Identify the endpoint and the target kind the authored route requires."""
    parts = [unquote(part) for part in url.path.strip("/").split("/")]
    raw_file = url.hostname == "raw.githubusercontent.com"
    if raw_file and (len(parts) < 4 or url.path.endswith("/")):
        raise InvalidLink("Raw GitHub URL needs a repository, ref, and file path")
    if len(parts) < 2:
        return None
    repo = f"repos/{quote(parts[0], safe='')}/{quote(parts[1], safe='')}"
    if raw_file:
        return github_contents(repo, parts[2:], raw_file=True)
    if len(parts) == 2:
        return GitHubTarget(repo)
    kind = parts[2]
    if kind in ("blob", "tree"):
        return github_contents(repo, parts[3:])
    if kind in ("issues", "pull") and len(parts) == 4 and parts[3].isdigit():
        return GitHubTarget(f"{repo}/{'pulls' if kind == 'pull' else 'issues'}/{parts[3]}")
    if kind == "commit" and len(parts) == 4:
        return GitHubTarget(f"{repo}/commits/{quote(parts[3], safe='')}")
    if kind == "releases":
        if parts[3:] == ["latest"]:
            return GitHubTarget(f"{repo}/releases/latest")
        if len(parts) == 6 and parts[3:5] == ["latest", "download"]:
            return GitHubTarget(f"{repo}/releases/latest", release_asset=parts[5])
        if len(parts) >= 5 and parts[3] == "tag":
            tag = "/".join(parts[4:])
        elif len(parts) >= 6 and parts[3] == "download":
            tag = "/".join(parts[4:-1])
        else:
            return None
        return GitHubTarget(
            f"{repo}/releases/tags/{quote(tag, safe='')}",
            release_asset=parts[-1] if parts[3] == "download" else None,
        )
    return None


def audit_url(item):
    """Classify confirmed missing links separately from blocked or unsupported probes."""
    value, sources = item
    result = {"url": value, "sources": sorted(set(sources))}
    try:
        url = split_reference(value)
        if url.scheme not in ("http", "https"):
            return None
        host, port = url.hostname, url.port
    except ValueError as error:
        return dict(result, status="broken", reason=f"Invalid URL: {error}")
    if host in ("rea.tools", "localhost", "127.0.0.1", "::1"):
        return None

    try:
        default_port = 443 if url.scheme == "https" else 80
        if host in ("github.com", "raw.githubusercontent.com") and port in (None, default_port):
            target = github_target(url)
            if target is None:
                return dict(result, status="unknown", reason="GitHub UI route; check in a browser")
            data = github_api(target.endpoint)
            if target.raw_file:
                if isinstance(data, list):
                    return dict(result, status="broken", reason="Raw GitHub URL points to a directory")
                if not isinstance(data, dict):
                    return dict(result, status="unknown", reason="Unexpected GitHub Contents response")
                if data.get("type") == "submodule" or data.get("submodule_git_url"):
                    return dict(result, status="broken", reason="Raw GitHub URL points to a submodule")
            if target.release_asset is not None and not any(
                asset["name"] == target.release_asset for asset in data.get("assets", [])
            ):
                return dict(result, status="broken", reason="Release asset is missing")
            return dict(result, status="ok", via="gh api", endpoint=target.endpoint)
        request = Request(value.split("#", 1)[0], headers={
            "User-Agent": "REA-Website-Verifier/1.0 (+https://github.com/morluto/rea)",
        })
        with urlopen(request, timeout=15) as response:
            return dict(result, status="ok", http_status=response.status, final_url=response.url)
    except HTTPError as error:
        return dict(result, status="broken" if error.code in (404, 410) else "unknown", reason=str(error))
    except (InvalidURL, InvalidLink) as error:
        return dict(result, status="broken", reason=f"Invalid URL: {error}")
    except ValueError as error:
        return dict(result, status="broken" if "HTTP 404" in str(error) else "unknown", reason=str(error))
    except (OSError, URLError, TimeoutError, subprocess.TimeoutExpired) as error:
        return dict(result, status="unknown", reason=str(error))


def external_links(root):
    """Collect authored HTTP candidates, including malformed ones with source locations."""
    references = {}

    def add(value, source):
        if re.match(r"\s*https?:", value, re.IGNORECASE):
            references.setdefault(value, []).append(str(source.relative_to(root)))

    for path in sorted((root / "website/public").rglob("*.html")):
        for value in html_references(path.read_text(encoding="utf-8")):
            add(value, path)
    for path in authored_markdown(root):
        for value in markdown_references(path.read_text(encoding="utf-8")):
            add(value, path)
    return references


def main():
    """Run an explicit network audit without making PR checks depend on third-party uptime."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, help="Write the complete JSON report outside public assets")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = [item for item in pool.map(audit_url, external_links(root).items()) if item is not None]
    if args.report:
        if args.report.resolve().is_relative_to(root / "website/public"):
            parser.error("Keep audit reports outside website/public.")
        args.report.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    counts = {status: sum(item["status"] == status for item in results) for status in ("ok", "broken", "unknown")}
    print(f"External links: {counts['ok']} reachable, {counts['broken']} broken, {counts['unknown']} need manual verification.")
    print("GitHub checks establish target existence; external fragment IDs are not checked.")
    for item in results:
        if item["status"] != "ok":
            print(f"{item['status']}: {item['url']} — {item['reason']}")
    return 1 if counts["broken"] else 0


if __name__ == "__main__":
    sys.exit(main())
