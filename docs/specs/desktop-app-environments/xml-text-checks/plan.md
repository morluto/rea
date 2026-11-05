# Plan

1. Parser: `parseXmlDocument` in `src/domain/xmlDocument.ts` gains the
   DOCTYPE policy `external`, which refuses a DOCTYPE whose text holds a `[`
   outside its quoted literals with the reason `internal-subset`, and
   `declaredDocumentType` reads the DOM's name and identifiers, unquoted, the
   public one normalized. saxes and xmldom read no DTD and already refuse any
   entity but XML's five.
2. State view: `detectStateFormat` and `xmlView` in `stateFormats.ts` use the
   `external` policy, and the view adds `doctype` when one is declared. One
   predicate, XML whitespace, decides both whether text is formatting and
   whether an element is mixed content.
3. Exported module: `_expat` in `appExportPythonXml.ts` turns parameter entity
   parsing off, refuses an internal subset, an external entity and a skipped
   entity, and passes the declaration to the reader; the namespace pass checks
   start tags through a default handler; `_XmlReader` tracks per element
   whether it holds text other than XML whitespace.
4. Checks: `text_equals` and `text_contains` in the schema, `textVerdict`
   with `isXmlElement` and `elementText` in `appTaskChecks.ts`, and
   `_whole_text` in the verifier's evaluator, in the same order of failures;
   the export's refusal of a pointer into text covers them.
5. Draft: `wholeTextSuggestions` in `appTaskDraft.ts`, used by the XML file
   and archive suggestions, with `namedPointer` naming an XML file's members
   by selector.
6. Docs and tests: a synthetic AbiWord save and a Writer `content.xml` split
   into runs, read alike by both readers and checked alike by both
   evaluators; the DOCTYPE cases each parser accepts and refuses; the shared
   check cases.
