## Purpose

Turns a Figma design and a Jira ticket into one consolidated, evidence-linked requirement for a single AEM Edge Delivery Services block, together with the disagreements between the two and a proposed Universal Editor content model. The design is the authority; the ticket is a claim about it that may be incomplete or wrong.

## ADDED Requirements

### Requirement: An analysis is submitted with a design reference and a ticket

The studio SHALL accept an analysis request carrying a design reference, a ticket, and a target block name, and SHALL reject one that lacks either source. The request SHALL be answerable while it is still running: the caller chooses the analysis id rather than receiving it, so progress can be asked for before the submitting request returns.

#### Scenario: Both sources present

- **WHEN** a request names a design node and carries a ticket, and an arm declaring `text.generate` is discovered
- **THEN** the analysis is registered under the caller's id, begins running, and its progress is readable immediately

#### Scenario: One source missing

- **WHEN** a request carries a ticket but no design reference
- **THEN** the request is refused as invalid, no analysis is registered, and the message names the missing source

#### Scenario: No arm can serve it

- **WHEN** no discovered arm declares the `text.generate` capability
- **THEN** the request is refused before any source is read, and the message distinguishes "no arm discovered" from "the supervisor is unreachable"

### Requirement: Analysis progress is reported step by step

An analysis crosses several external systems and several model passes, and SHALL report each as its own step with its own state and elapsed time rather than as a single indeterminate wait. A step that a model pass produced SHALL carry that pass's own steps beneath it.

#### Scenario: A run in flight

- **WHEN** progress is requested for a running analysis
- **THEN** the response lists every step reached so far, each marked pending, running, done or failed, with elapsed seconds for those that have started

#### Scenario: A model pass is running

- **WHEN** a pass has submitted work to an arm and that arm is reporting its own steps
- **THEN** the arm's steps appear as children of the pass's step

#### Scenario: A step fails

- **WHEN** any step fails
- **THEN** that step is marked failed with the reason, the analysis stops, later steps stay pending, and the artefacts produced by the steps that did succeed remain readable

### Requirement: Several viewports are one block

Where an analysis reads several frames, the design inventory SHALL enumerate each element once however many views it appears in, and MAY cite the node id from whichever view showed it. An element that differs between views SHALL record how it differs.

Responsive behaviour is a reading of the design and therefore a requirement like any other -- and where the ticket never describes it, a gap. It SHALL NOT become a content field: no viewport, breakpoint or per-device variant belongs in the Universal Editor model, because nobody authors a breakpoint.

#### Scenario: One headline, three frames

- **WHEN** a block is read at three viewports and each draws the same headline
- **THEN** the inventory holds one headline element, and the proposed model holds one headline field

#### Scenario: An element that changes between viewports

- **WHEN** an element is present in the desktop frame and absent in the mobile one
- **THEN** the inventory records the difference, and where the ticket does not describe it the reconciliation reports it as a gap

#### Scenario: A citation from a narrower frame

- **WHEN** an element cites the node id it carries in the second view
- **THEN** the citation resolves, because every view's ids form one evidence set

### Requirement: Every requirement carries its evidence

A statement in the consolidated requirement SHALL record where it came from: the design node id, the ticket section, or both. A statement supported by neither SHALL be marked as inferred and SHALL be listed separately from statements that are asserted.

#### Scenario: A statement the design supports

- **WHEN** a requirement is derived from a design node
- **THEN** it carries that node's id, and the id resolves to a node present in the design that was read

#### Scenario: A statement neither source supports

- **WHEN** the model produces a statement with no design node and no ticket passage behind it
- **THEN** it is recorded as inferred rather than asserted, and appears in the output under inferences rather than among the requirements

### Requirement: The design wins a contradiction

Where the design and the ticket disagree about an observable property, the analysis SHALL record the design's reading as the requirement and the ticket's as the contradiction. It SHALL NOT silently drop either, and SHALL NOT resolve the disagreement by preferring the ticket.

#### Scenario: Ticket contradicts the design

- **WHEN** the ticket says a control is a link and the design shows a button
- **THEN** the requirement states the button, and the gap list records the contradiction naming both readings and the node id

#### Scenario: The ticket describes something absent from the design

- **WHEN** the ticket describes behaviour with no counterpart in the design
- **THEN** it is recorded as a gap of kind "not in design" rather than as a requirement, because the design is the authority on what exists

#### Scenario: The design shows something the ticket never mentions

- **WHEN** the design carries a state, variant or element the ticket does not describe
- **THEN** it is recorded as a requirement — the design is authoritative — and also listed as a gap of kind "undocumented", because the ticket needs updating

### Requirement: A gap names what to do about it

Each entry in the gap list SHALL carry a kind, the evidence for it, and a question that can be put to a person. A gap without a question is not actionable and SHALL NOT be reported.

#### Scenario: An ambiguity is reported

- **WHEN** a property is visible in the design but its behaviour is undetermined — a truncation rule, an empty state, a breakpoint the design does not cover
- **THEN** the gap records the kind, the node id, and a question naming the decision that is missing

### Requirement: A Universal Editor model is proposed

The analysis SHALL produce a content model for the block in the form `aem-boilerplate-xwalk` consumes: one JSON document carrying `definitions`, `models` and `filters` arrays, suitable for saving as `blocks/<name>/_<name>.json`.

#### Scenario: A simple block

- **WHEN** the design shows one instance of the block with no repeating children
- **THEN** the document carries one definition using the block resource type, one model whose fields cover the authorable content, and an empty filters array

#### Scenario: A block with repeating items

- **WHEN** the design shows the same child component repeated
- **THEN** the document carries a definition for the container and one for the item using the block item resource type, a model for the item, and a filter naming the item as the container's only permitted child

#### Scenario: A block with visual variants

- **WHEN** the design shows the block in more than one variant
- **THEN** the model carries a field in the classes group offering those variants, so they reach the block as CSS classes rather than as content

#### Scenario: The proposal is not valid JSON

- **WHEN** the model's output cannot be parsed, or does not carry the three arrays
- **THEN** the step fails with the parse error and the raw output is kept, rather than an invalid document being offered as a result

### Requirement: An analysis is readable without being parsed

An analysis SHALL produce documents a person reads as well as documents a tool reads, and the console SHALL render the documents rather than display their source. A gap list presented as JSON is a machine artefact shown to a human being.

The gaps SHALL be available as a worklist in their own right -- one heading per gap, its readings under it and its question last -- distinct from the gap section of the requirement document, because closing open decisions is a different activity from learning what the block is.

#### Scenario: The gaps on screen

- **WHEN** a completed analysis is shown
- **THEN** the gaps are rendered as a document, with each gap's question reachable without reading JSON

#### Scenario: What is copied

- **WHEN** a rendered document is copied
- **THEN** the markdown source is placed on the clipboard, not the rendering -- the destinations for such a copy render markdown themselves

#### Scenario: Ticket content that looks like markup

- **WHEN** a ticket passage contains HTML, as a pasted ticket may
- **THEN** it is displayed as text and no tag from it reaches the document

### Requirement: The proposed model is explained, and doubted

The proposed content model SHALL be presented in a form that answers an author's questions -- what each field asks for, which fields are companions of another, which fields are not content -- as well as in the form a developer merges.

That presentation SHALL end with what is demonstrably wrong with the proposal. The fourth pass is the least reliable of the four and its characteristic failures parse cleanly, so nothing else in the pipeline reports them.

#### Scenario: A field pair

- **WHEN** the model holds an asset field and its `<name>Alt` sibling
- **THEN** they are presented as one control with a second field beneath it, not as two independent things to fill in

#### Scenario: A variant field

- **WHEN** the model holds a `classes` field
- **THEN** it is presented apart from the content fields and described as reaching the block as a CSS class

#### Scenario: A filter that names nothing

- **WHEN** a proposed filter carries an empty component list
- **THEN** it is reported as a finding, because the block would author as one nothing can be placed inside

#### Scenario: An image with no alt field

- **WHEN** a proposed asset field has no `<name>Alt` beside it
- **THEN** it is reported as a finding, and as an accessibility failure rather than a preference

#### Scenario: A proposal that passes every check

- **WHEN** nothing in the proposal trips a check
- **THEN** the report says so without claiming the proposal is correct

### Requirement: An analysis is kept

The inputs and the artefacts of an analysis SHALL be written to managed storage under an identifier, before the first model pass rather than after the last, so that a run interrupted by a restart leaves what it had read. Analyses SHALL NOT appear in the media library.

#### Scenario: Inputs are recorded before work begins

- **WHEN** an analysis has read its design and its ticket and is about to run its first pass
- **THEN** both normalised sources are already on disk under the analysis id

#### Scenario: The process restarts mid-run

- **WHEN** the web application restarts while an analysis is running
- **THEN** the analysis is reported as failed rather than as still running, and its stored inputs and any completed artefacts are still readable

### Requirement: The arm is named by the request, not by the pipeline

The analysis SHALL run its passes against an arm the request names, and SHALL carry the start parameters that arm needs with each pass. No instruction, schema or rule about the analysis shall live in an arm.

#### Scenario: Two arms compared on one input

- **WHEN** the same design and ticket are analysed twice, naming a different `text.generate` arm each time
- **THEN** both runs complete without any change to the pipeline, and each result records which arm produced it
