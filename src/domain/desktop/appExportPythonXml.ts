/** The generated module's XML reader: REA's XML view of a document, built with expat. */
export const PYTHON_XML_READER = String.raw`def _expat(namespaces: bool):
    """An expat parser that refuses DOCTYPEs as REA does; with namespaces it also enforces their rules, as REA's
    parser does, and without them it reports names as the document spells them."""
    parser = expat.ParserCreate(namespace_separator=" " if namespaces else None)

    def doctype(*_) -> None:
        raise ValueError("the document declares a DOCTYPE")

    parser.StartDoctypeDeclHandler = doctype
    return parser


class _XmlReader:
    """REA's XML view built as expat reads: names as spelled, declarations as attributes, text split where REA's DOM
    splits it (an empty CDATA section joins the text around it), and each node counted against REA's limits."""

    def __init__(self) -> None:
        self.remaining, self.truncated, self.root = MAX_XML_NODES, False, None
        #: Per open element: its view or None when left out, whether xml:space="preserve" applies inside it, and
        #: whether it holds an element, which makes whitespace-only text in it formatting.
        self.open = []
        self.text, self.cdata = [], None

    def read(self, text: str) -> None:
        parser = _expat(False)
        parser.buffer_text = True
        parser.StartElementHandler, parser.EndElementHandler = self._start, self._end
        parser.CharacterDataHandler = self._data
        parser.StartCdataSectionHandler, parser.EndCdataSectionHandler = self._cdata_start, self._cdata_end
        parser.CommentHandler = parser.ProcessingInstructionHandler = self._other
        parser.Parse(text, True)

    def _admit(self) -> bool:
        """Whether the next node inside a kept element is kept, within the node and depth limits; one past them
        marks the view truncated."""
        if self.open and self.open[-1][0] is None:
            return False
        if self.remaining <= 0 or len(self.open) > MAX_XML_DEPTH:
            self.truncated = True
            return False
        self.remaining -= 1
        return True

    def _text_node(self, text: str) -> None:
        if self._admit():
            self.open[-1][0]["children"].append(text)

    def _flush(self) -> None:
        if self.text:
            text, self.text = "".join(self.text), []
            self._text_node(text)

    def _data(self, text: str) -> None:
        (self.text if self.cdata is None else self.cdata).append(text)

    def _cdata_start(self) -> None:
        self.cdata = []

    def _cdata_end(self) -> None:
        text, self.cdata = "".join(self.cdata), None
        if text:
            self._flush()
            self._text_node(text)

    def _other(self, *_) -> None:
        """A comment or processing instruction, counted like any node and never kept."""
        self._flush()
        if self.open:
            self._admit()

    def _start(self, name: str, attributes: dict) -> None:
        self._flush()
        parent = self.open[-1] if self.open else [None, False, False]
        parent[2] = True
        view = {"name": name, "attributes": attributes, "children": []} if self._admit() else None
        if view is not None and parent[0] is not None:
            parent[0]["children"].append(view)
        space = attributes.get(XML_SPACE)
        self.open.append([view, space == "preserve" if space else parent[1], False])

    def _end(self, _name: str) -> None:
        self._flush()
        view, preserve, holds_element = self.open.pop()
        if view is not None and holds_element and not preserve:
            view["children"] = [child for child in view["children"] if not isinstance(child, str) or _js_trim(child)]
        if not self.open:
            self.root = view


def _xml_view(text: str):
    """REA's XML view, or None for a document REA's parser refuses: a pass with namespaces checks the document as REA's
    parser does, then a pass without them reads names as spelled, as REA's view keeps them."""
    reader = _XmlReader()
    try:
        _expat(True).Parse(text, True)
        reader.read(text)
    except (expat.ExpatError, ValueError):
        return None
    return {"root": reader.root, "truncated": reader.truncated}
`;
