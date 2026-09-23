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
