## Purpose

Turns whatever a person can get out of Jira into one normalised ticket the pipeline can read. Jira's issue view exports Word, XML and Print rather than JSON, so the studio accepts files rather than assuming an API: the format is detected from the content, and every path produces the same shape.

## ADDED Requirements

### Requirement: A ticket may be imported or pasted

The studio SHALL accept a ticket as an uploaded file or as pasted text, and SHALL NOT require credentials for either. A pasted ticket SHALL be as usable as an imported one.

#### Scenario: Pasted text

- **WHEN** a ticket is submitted as pasted text with no file
- **THEN** it is accepted, and the normalised ticket carries the text as its description with no key, status or comments

#### Scenario: Neither file nor text

- **WHEN** a request carries an empty ticket
- **THEN** it is refused as invalid before any design is read

### Requirement: The import format is detected, not declared

The format of an imported ticket SHALL be determined from the file's content rather than from its name or the uploader's claim, and an unrecognised file SHALL be refused with its detected type named.

#### Scenario: A Jira XML export

- **WHEN** a file is Jira's XML issue export
- **THEN** it is parsed as XML regardless of its extension

#### Scenario: An export with no XML declaration

- **WHEN** a file opens with an HTML comment and carries no `<?xml ?>` declaration, which is what Jira actually writes
- **THEN** the preamble is skipped, the root tag is found past it, and the file is still recognised as the XML export

#### Scenario: A Word export that is really HTML

- **WHEN** a file named `.doc` contains HTML, which is what Jira's Word export produces
- **THEN** it is parsed as HTML rather than refused for not being a Word binary

#### Scenario: A format nothing can read

- **WHEN** a file is neither XML, HTML, PDF nor text
- **THEN** it is refused, naming what it appeared to be, and no analysis is started

### Requirement: Every format produces one normalised ticket

Whatever the import path, the result SHALL be one ticket carrying, where the source has them: key, summary, status, issue type, description as plain text or Markdown, acceptance criteria, comments, custom field values, and the names of attachments. Fields a format cannot supply SHALL be absent rather than invented.

#### Scenario: XML carries the most

- **WHEN** a Jira XML export is parsed
- **THEN** the normalised ticket carries key, summary, status, type, description, comments, custom fields and attachment names

#### Scenario: A print-to-PDF carries less

- **WHEN** a PDF of the printed issue is parsed
- **THEN** the normalised ticket carries what the text of the page supports, and the fields the format cannot distinguish are absent rather than guessed

#### Scenario: Markup becomes text

- **WHEN** a description arrives as HTML
- **THEN** it is converted to plain text or Markdown preserving headings, lists and tables, because acceptance criteria are usually a list and losing the list loses the criteria

### Requirement: A malformed table loses nothing

A wiki renderer reads its own cell separator inside an author's text as a cell boundary, so an exported row may carry more cells than its header has columns. The parser SHALL preserve the whole of such a row rather than truncating it to the header's width.

#### Scenario: A row split by a literal separator character

- **WHEN** a table row has more cells than the header has columns
- **THEN** the surplus cells are rejoined into the last column using the separator character that split them, and no text from the row is dropped

#### Scenario: A row with too few cells

- **WHEN** a table row has fewer cells than the header has columns
- **THEN** it is padded to the header's width rather than misaligning the columns that follow

### Requirement: Comments are read as part of the ticket

Comments SHALL be parsed into the normalised ticket alongside the description. A requirement agreed in a thread and never written back into the description exists only in the comments, and is exactly the kind of statement an analysis must be able to find.

#### Scenario: A comment carries a claim the description contradicts

- **WHEN** the description specifies one thing and a comment specifies another
- **THEN** both reach the normalised ticket as separate, separately citable content, so the disagreement can be reported rather than silently resolved by whichever was read

### Requirement: A ticket's passages can be cited

The normalised ticket SHALL be divided into addressable passages, so that a requirement or a gap can name the part of the ticket it came from rather than the ticket as a whole.

#### Scenario: A requirement cites the ticket

- **WHEN** a statement is derived from the ticket's acceptance criteria
- **THEN** it carries an identifier resolving to that passage, and the passage is present in the stored ticket

### Requirement: Attachments are named, not read

Images attached to a ticket SHALL be recorded by name so that a reader knows what was not consulted. The studio SHALL NOT download an attachment, because the import path carries no credentials.

#### Scenario: A ticket with a screenshot attached

- **WHEN** an export names an attachment
- **THEN** the normalised ticket lists its name, and the analysis records that the attachment's content was not read
