# REA website figures

The published diagrams are SVG source assets:

- `public/assets/figures/rea-investigation-flow.svg` — 1774 × 887 viewBox.
- `public/assets/figures/dx-ball-sound-pan-investigation.svg` — 1774 × 887 viewBox.
- `public/assets/figures/th04-bullet-ring.svg` — 1000 × 520 viewBox.

Two original layout references were generated with the built-in image generation
tool and reviewed visually. Their prompts are retained below. The final SVGs
preserve the white background, charcoal/slate/blue palette and layout while
using REA as the reader-facing subject. Provider details remain in configuration
guides and the evidence provenance document. The SVGs keep text sharp when
zoomed and can be maintained without committing raster binaries.

The REA figure shows the agent's question, inspection through REA, evidence and
follow-up work. The DX-Ball figure shows the ordered input/arithmetic evidence,
the maintained C and separate execution/compiler checks. Recorded tool requests,
instruction excerpts and decoded byte reads appear as HTML text in the case
study; source reconstruction is the agent's work informed by REA results.

## TH04 figure

The TH04 figure is drawn directly as SVG from the byte-angle formula. It uses
16 bullets, zero template rotation and illustrative player direction 40, with
clockwise screen coordinates. The HTML overview separates REA's original-code
inspection from the reconstruction project's C++ and compiler replay. No
image generation or game screenshot is used for this mathematical figure.

## Review

Check spelling, arithmetic order, arrow directions and the separate verification
branches when changing these figures. Match progress claims to the pinned
reconstruction checkpoint. Validate the SVG as XML and inspect its browser
rendering at desktop and mobile widths.

## Original image generation prompts

## Prompt 1

Use case: scientific-educational
Asset type: project-bound raster diagram for the REA website, readable at 1080px display width.
Primary request: Make one exceptionally clear, publication-style flow figure explaining how an analyst and their agent use REA to investigate a local target. The reader should understand the roles and sequence in one glance.
Canvas: wide landscape 2:1 aspect ratio, approximately 2048 × 1024 pixels. Plain pure-white background. Generous clear outer margin. Flat vector-like graphic rendered as raster.
Style: restrained technical-paper figure. Crisp large sans-serif type. Charcoal #20252b text, slate #5b6570 secondary text, thin gray connecting lines, one muted blue #294f82 accent for REA and meaningful connections. No decorative illustration.

Layout and exact labels:
A short title at the top left: "REA investigation flow".
Four clear evenly spaced stages along a single left-to-right horizontal baseline. Each stage has a prominent numbered heading, concise centered labels, and ample whitespace. Main connectors are right-pointing arrows between adjacent stages.
Stage 1:
"1. Ask"
"Your agent + local target"
"App / binary / browser"
Stage 2:
"2. Inspect & trace"
A large blue label "REA"
"CLI / MCP"
Stage 3:
"3. Read the evidence"
"Code / references / unknowns"
Stage 4:
"4. Use what you learn"
A large label "Your agent"
"Explain / implement / test"

Below stage 2 only, put a supporting box and a thin vertical connector to REA. Box labels verbatim:
"Analysis tools"
"Ghidra / Hopper / IDA / other adapters"
It is a set of available adapters, not a requirement that all engines be used. Do not put this box under other stages.
Add exactly one subtle feedback arrow above the main row: from stage 4 back to stage 2, pointing into REA. Its label is "Follow-up question". Do not cross text.
Semantics: REA provides inspection and analysis evidence via CLI/MCP. The user's agent uses that evidence to explain, implement, or test. Never imply REA automatically clones a program.
Text: Render every supplied English label verbatim with correct spelling. Keep type large and dark enough to read when image is displayed at 1080px wide. Do not add additional captions, claims, legends, text, code, logos, icons, or numbers.
Avoid: screenshots, assembly or source code, watermarks, shadows, gradients, 3D, cute icons, bold marketing banners, ornate borders, dense text, tiny labels, decorative arrows.

## Prompt 2

Use case: scientific-educational
Asset type: project-bound raster figure for a restrained REA technical case-study web page, readable at 1080px display width.
Primary request: Draw one accurate, instantly understandable publication-style diagram of the DX-Ball sound-pan function investigation. Show the original executable feeding REA/Ghidra analysis, the ordered arithmetic evidence, the maintained C reconstruction, and two separate verification checks. This concerns ONE FUNCTION, not the entire game.
Canvas: wide landscape 2:1 aspect ratio, approximately 2048 × 1024 pixels. Pure-white background, generous outer margins. Flat vector-like diagram rendered as raster.
Style: crisp large sans-serif, charcoal #20252b primary text, slate #5b6570 secondary text and thin outlines, one restrained blue #294f82 accent. Only boxes, simple lines, arrows and typography. No shadows, gradients, 3D, icons or screenshots.

Composition:
At top left, a concise title "DX-Ball sound-pan investigation".
The main upper row proceeds from left to right across three clearly separated regions: a compact source box on the far left, a wide central analysis region, then a compact implementation box on the right. Use meaningful arrows connecting them. Reserve lower space for a caller input on the lower left and verification checks on the lower right, with no crossing connectors or cramped text.

Exact labels and relationships:
SOURCE: box text "DXBALL.EXE" with "0x00406400" underneath.
Arrow from SOURCE into the first node of the central region.

CENTRAL EVIDENCE REGION: heading "REA + Ghidra".
Five little arithmetic nodes in exactly this order, joined by right-pointing arrows:
"Stack input x" → "× 1.5625" → "− 500.0" → "× pan_scale" → "Integer return"
The last node connects to the maintained C box on the right.
The operations MUST remain in this order; these are arithmetic evidence labels, not source code. Use the true multiplication symbol × and minus symbol −, never a plus.
Put a supporting caller box below the first input, connected by a single arrow ONLY to "Stack input x". Its exact labels are "Brick-hit caller" and "20 + 30 × tile_x". This supplies the input position. Do not connect the caller to the multiplier or to later operations.

IMPLEMENTATION REGION on the right: small heading "Reconstructed function" with prominent box text "Maintained C".
Below this output, draw a fork into TWO distinct verification boxes; both receive a connector from Maintained C, and neither receives a connector from the other check. These checks are independent branches, never a single serial validation.
First check labels verbatim:
"Original-x86 comparison"
"3,205 cases"
Second check labels verbatim:
"VC4.0 compiler replay"
"63 matching bytes"
Use enough horizontal space for clear check names and generous typography. A two-line label is fine where needed.

Text constraints: render every supplied English label and number verbatim with correct spelling. No extra claims, no additional labels, no footnotes, no source code or assembly, no logos or watermarks. Keep all connectors complete and directed correctly. Large legible labels matter more than decorative density. Never say full reconstruction, exact game clone, all bytes, or automatic source recovery.
