/** The generated module's XML reader: REA's XML view of a document, built with expat. */
export const PYTHON_XML_READER = String.raw`#: XML's whitespace, which alone can be formatting between elements; Unicode's wider set is text.
XML_WHITESPACE = " \t\r\n"
PREDEFINED_ENTITIES = ("amp", "lt", "gt", "apos", "quot")
ENTITY_REFERENCE = re.compile(r"&([^#;][^;]*);")
#: A line ending as XML normalizes it before parsing; expat leaves a DOCTYPE's system literal as written.
XML_LINE_ENDING = re.compile(r"\r\n?")


def _expat(namespaces: bool, doctype=None):
    """An expat parser that reads a DOCTYPE as REA does: one with an internal subset, which could declare entities,
    is refused, the DTD it names is never read, and a reference to an entity other than XML's five is refused where
    expat would skip it. With namespaces it also enforces their rules, as REA's parser does, and without them it
    reports names as the document spells them. doctype, when given, receives the declared name and identifiers."""
    parser = expat.ParserCreate(namespace_separator=" " if namespaces else None)
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)

    def declared(name: str, system_id, public_id, internal_subset: bool) -> None:
        if internal_subset:
            raise ValueError("the document's DOCTYPE has an internal subset")
        if doctype is not None:
            if system_id is not None:
                system_id = XML_LINE_ENDING.sub("\n", system_id)
            doctype({"name": name, "public_id": public_id, "system_id": system_id})

    def undeclared(name: str, _parameter: bool) -> None:
        raise ValueError(f"the document refers to the undeclared entity {name}")

    def external(*_) -> None:
        raise ValueError("the document refers to an external entity")

    parser.StartDoctypeDeclHandler = declared
    parser.SkippedEntityHandler = undeclared
    parser.ExternalEntityRefHandler = external
    return parser


def _check_tag(markup: str) -> None:
    """expat leaves an undeclared entity out of an attribute value without a word when a DOCTYPE names a DTD; REA's
    parser refuses it. With text taken by its own handler, a start tag is the only markup expat passes here that
    starts with < and a name, and it passes it whole."""
    if markup[:1] == "<" and markup[1:2] not in ("!", "?", "/"):
        for name in ENTITY_REFERENCE.findall(markup):
            if name not in PREDEFINED_ENTITIES:
                raise ValueError(f"the document refers to the undeclared entity {name}")


def _ignore_text(_text: str) -> None:
    pass


class _XmlReader:
    """REA's XML view built as expat reads: names as spelled, declarations as attributes, text split where REA's DOM
    splits it (an empty CDATA section joins the text around it), and each node counted against REA's limits."""

    def __init__(self) -> None:
        self.remaining, self.truncated, self.root, self.doctype = MAX_XML_NODES, False, None, None
        #: Per open element: its view or None when left out, whether xml:space="preserve" applies inside it, whether
        #: it holds an element, and whether it holds text other than whitespace: whitespace-only text is formatting
        #: only in an element that holds elements and no such text.
        self.open = []
        self.text, self.cdata = [], None

    def read(self, text: str) -> None:
        parser = _expat(False, self._doctype)
        parser.buffer_text = True
        parser.StartElementHandler, parser.EndElementHandler = self._start, self._end
        parser.CharacterDataHandler = self._data
        parser.StartCdataSectionHandler, parser.EndCdataSectionHandler = self._cdata_start, self._cdata_end
        parser.CommentHandler = parser.ProcessingInstructionHandler = self._other
        parser.Parse(text, True)

    def _doctype(self, declared: dict) -> None:
        self.doctype = declared

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
        if self.open and text.strip(XML_WHITESPACE):
            self.open[-1][3] = True
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
        parent = self.open[-1] if self.open else [None, False, False, False]
        parent[2] = True
        view = {"name": name, "attributes": attributes, "children": []} if self._admit() else None
        if view is not None and parent[0] is not None:
            parent[0]["children"].append(view)
        space = attributes.get(XML_SPACE)
        self.open.append([view, space == "preserve" if space else parent[1], False, False])

    def _end(self, _name: str) -> None:
        self._flush()
        view, preserve, holds_element, holds_text = self.open.pop()
        if view is not None and holds_element and not holds_text and not preserve:
            view["children"] = [child for child in view["children"]
                                if not isinstance(child, str) or child.strip(XML_WHITESPACE)]
        if not self.open:
            self.root = view


def _xml_view(text: str):
    """REA's XML view, or None for a document REA's parser refuses: a pass with namespaces checks the document as REA's
    parser does, then a pass without them reads names as spelled, as REA's view keeps them, and the DOCTYPE."""
    reader = _XmlReader()
    try:
        check = _expat(True)
        check.CharacterDataHandler, check.DefaultHandler = _ignore_text, _check_tag
        check.Parse(text, True)
        reader.read(text)
    except (expat.ExpatError, ValueError):
        return None
    view = {"root": reader.root, "truncated": reader.truncated}
    return view if reader.doctype is None else {"doctype": reader.doctype, **view}
`;
