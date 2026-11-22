"""Read references from authored website formats before resolving their targets."""

from html.parser import HTMLParser
import re
from urllib.parse import urlsplit

from markdown_it import MarkdownIt
import yaml


class ReferenceMarkdown(MarkdownIt):
    def normalizeLink(self, url):
        # Keep the destination available for validation, including malformed URLs.
        return url


_MARKDOWN = ReferenceMarkdown("commonmark").enable("table")
_FRONT_MATTER = re.compile(
    r"\A\ufeff?---[ \t]*\r?\n(.*?)^---[ \t]*(?:\r?\n|\Z)",
    re.MULTILINE | re.DOTALL,
)


def parse_markdown(source):
    """Parse the document body, excluding a leading YAML metadata mapping."""
    front_matter = _FRONT_MATTER.match(source)
    if front_matter:
        try:
            metadata = yaml.compose(front_matter[1], Loader=yaml.SafeLoader)
        except yaml.YAMLError:
            pass
        else:
            if isinstance(metadata, yaml.MappingNode):
                source = source[front_matter.end():]
    return _MARKDOWN.parse(source)


def html_references(source):
    references = []

    class Links(HTMLParser):
        def handle_starttag(self, tag, attrs):
            references.extend(value for key, value in attrs if key in ("href", "src") and value)

    parser = Links()
    parser.feed(source)
    parser.close()
    return references


def markdown_references(source):
    """Yield link and image destinations as Markdown would interpret them."""
    def destinations(tokens):
        for token in tokens:
            if token.type == "link_open":
                yield token.attrGet("href")
            elif token.type == "image":
                yield token.attrGet("src")
            elif token.type in ("html_block", "html_inline"):
                yield from html_references(token.content)
            if token.children:
                yield from destinations(token.children)

    return destinations(parse_markdown(source))


def split_reference(value):
    url = urlsplit(value)
    if url.scheme in ("http", "https"):
        if not url.hostname:
            raise ValueError("missing hostname")
        # urllib checks port syntax lazily when this attribute is read.
        _ = url.port
    return url


def local_reference(value):
    """Select relative paths for translation; leave malformed links to verification."""
    try:
        url = split_reference(value)
    except ValueError:
        return None
    if url.scheme or url.netloc or not url.path:
        return None
    return url
