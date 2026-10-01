## Purpose

Reads a design and hands back something a context window can hold: the node tree, the tokens, the picture, and enough text and layout to reason about, with every fact keyed by the node id it came from. One adapter is implemented — Figma's Dev Mode MCP server, running locally alongside the Figma desktop app — behind a contract that a REST adapter can satisfy later.

## ADDED Requirements

### Requirement: A design is named by a link

A design reference SHALL be a Figma link carrying a file key and a node id. The node id SHALL be accepted in either the form a browser URL uses or the form the API uses, and both SHALL resolve to the same node.

#### Scenario: A design link with a node

- **WHEN** a link of the form `https://www.figma.com/design/<fileKey>/<name>?node-id=123-456` is submitted
- **THEN** it resolves to file key `<fileKey>` and node `123:456`

#### Scenario: A link with no node

- **WHEN** a Figma link carries no node id
- **THEN** the request is refused, naming the missing node — a whole file is not a block, and reading one would be neither affordable nor meaningful

#### Scenario: A link that is not Figma

- **WHEN** the reference is not a Figma URL
- **THEN** the request is refused before any connection is attempted

#### Scenario: A link pasted inside the text it was copied with

- **WHEN** the submitted text contains a Figma link surrounded by other words, as an editor's "add to context" writes it
- **THEN** the link is extracted from its surroundings and read, rather than the whole paste being refused as not a URL

#### Scenario: Nothing in the text is a Figma link

- **WHEN** the submitted text contains no figma.com URL at all
- **THEN** the request is refused saying no Figma link was found, rather than quoting the text back as a malformed URL

### Requirement: One block may be named by several frames

A block is drawn at several viewports, and each viewport is its own frame with its own link. The submitted text MAY therefore carry several links, and all of them SHALL be read as views of one block. The first link SHALL be the primary view.

Every link SHALL be to the same Figma file. A node id is unique within a file and meaningless outside it, and the evidence check verifies every citation against the union of the views' ids -- so a set spanning two files could verify a citation against a frame it never came from.

#### Scenario: Three viewports of one block

- **WHEN** three links to frames in one file are submitted
- **THEN** all three are read, each is labelled by its frame's own name, and the analysis records every one of them

#### Scenario: Links to two different files

- **WHEN** the submitted links are to more than one file key
- **THEN** the request is refused before any connection is attempted, naming the files

#### Scenario: The same link twice

- **WHEN** a link appears twice in the submitted text
- **THEN** it is read once, and no problem is reported -- pasting a link twice is a slip, not a request for two reads

#### Scenario: More links than an analysis reads

- **WHEN** more links are submitted than the analysis will read
- **THEN** the request is refused, because every frame is a round trip and a share of one context window

### Requirement: Several views share one digest budget

The digest budget belongs to the context window, not to the number of frames. Reading a block at several viewports SHALL divide the one budget between them rather than multiplying it, subject to a floor below which a view would no longer describe the block. A single view SHALL receive exactly the budget it would have received before several were possible.

#### Scenario: One view

- **WHEN** one frame is read
- **THEN** it receives the full default budget

#### Scenario: Three views

- **WHEN** three frames are read
- **THEN** each receives about a third of the budget -- what the split costs is mostly repetition, since the three trees are near-identical

### Requirement: The expensive optional reads are taken once

A rendering of the frame and the source's own code guess SHALL be requested for the primary view only. Neither says anything about the narrower frames that the primary has not already said, and both are paid for in context or in seconds.

#### Scenario: Three views, one code guess

- **WHEN** three frames are read
- **THEN** the design context is requested once, and the digests of all three reach the model

### Requirement: Design reading is an adapter, not a call site

The pipeline SHALL read designs only through one contract: given a design reference, return a normalised design. Adding a second way to reach Figma SHALL NOT require changing any pass, prompt, route or page.

#### Scenario: A second adapter is added

- **WHEN** an adapter other than the MCP one is registered and selected
- **THEN** the pipeline runs unchanged and the result records which adapter read the design

### Requirement: The design is reduced before it is read by a model

A node tree SHALL be reduced to a digest bounded in size before any of it reaches a model. The reduction SHALL be deterministic — the same design produces the same digest — and SHALL preserve the node id of everything it keeps.

#### Scenario: What survives the reduction

- **WHEN** a frame is read
- **THEN** the digest keeps each kept node's id, name, type, size and position, its text content, its layout and spacing, its component and variant names, and whether it carries an image fill

#### Scenario: What the reduction drops

- **WHEN** the tree contains nodes that are invisible, fully transparent, or decorative vector geometry
- **THEN** they are dropped from the digest, and the count of dropped nodes is reported so that a reader knows the digest is a reduction

#### Scenario: A tree too large for the budget

- **WHEN** the reduced digest would still exceed the size budget
- **THEN** it is truncated by depth rather than by cutting off mid-tree, and the digest records that it was truncated and at what depth

### Requirement: Design tokens are read as tokens

Where the design uses variables or styles, the digest SHALL carry their names alongside the resolved values, so that a requirement can name a token rather than a hex value.

#### Scenario: A colour bound to a variable

- **WHEN** a node's fill is bound to a design variable
- **THEN** the digest records the variable's name and its resolved value, not the value alone

### Requirement: A rendering of the design is available

The adapter SHALL be able to return a rendered image of the referenced node, so that a pass may be given the picture as well as the tree. An adapter or an arm unable to supply or accept one SHALL degrade to the digest alone rather than fail.

#### Scenario: The arm cannot read images

- **WHEN** the selected arm does not accept images
- **THEN** the render is not requested, the analysis proceeds on the digest, and the result records that no rendering was used

### Requirement: An unreachable design source says why

The Figma MCP server is a separate application's process. Its absence SHALL be reported as a distinguishable cause rather than as a generic failure.

#### Scenario: The desktop app is not running

- **WHEN** nothing is listening on the local MCP endpoint
- **THEN** the step fails saying the Figma desktop app is not running or its local MCP server is not enabled, and naming where the studio looked

#### Scenario: The file is not open

- **WHEN** the server is reachable but refuses the node
- **THEN** the step fails saying the node could not be read in the running Figma session, rather than reporting the server as down

#### Scenario: The server stops answering mid-read

- **WHEN** a call to the design source exceeds its time budget
- **THEN** the step fails with a timeout naming the call that hung, and the analysis does not sit indefinitely
