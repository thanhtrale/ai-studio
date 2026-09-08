## Purpose

Defines the browser-facing application: the surface through which a person inspects available arms, controls which one currently holds the GPU, and from which all arm traffic is relayed.

## ADDED Requirements

### Requirement: The development server is served over HTTPS

The development server SHALL serve the application over HTTPS without requiring the developer to obtain or install certificate material as a prerequisite. Certificate material generated for development SHALL NOT be committed to version control.

#### Scenario: Starting the development server

- **WHEN** the development server is started from a clean checkout with no certificate files present
- **THEN** the application is reachable over an `https://` origin

#### Scenario: Certificate material stays untracked

- **WHEN** certificate or key files are generated into the working tree
- **THEN** version control reports no changes for them

### Requirement: All arm traffic is relayed by the application server

The application SHALL relay browser requests destined for an arm through its own server side. The browser SHALL NOT be required to connect to an arm directly.

#### Scenario: Browser never addresses an arm

- **WHEN** a page performs an operation that involves an arm
- **THEN** every request the browser issues targets the application's own origin

#### Scenario: Relay preserves failure information

- **WHEN** a relayed request fails because the arm is not running or returned an error
- **THEN** the client receives a response distinguishing "arm not running" from "arm returned an error"

### Requirement: The application presents the arm inventory

The application SHALL present the discovered arms with, for each, its identifier, modality, and current lifecycle state. Arms whose manifest failed validation SHALL be shown as invalid together with the reason.

#### Scenario: Inventory is displayed

- **WHEN** the arm inventory view is opened
- **THEN** every discovered arm is listed with its modality and current state

#### Scenario: State changes are reflected

- **WHEN** an arm transitions between states while the inventory view is open
- **THEN** the displayed state updates without requiring a full page reload

#### Scenario: Invalid arm is surfaced

- **WHEN** an arm's manifest failed validation
- **THEN** it is listed as invalid with its validation error, and it offers no start control

### Requirement: Arms can be started and stopped from the application

The application SHALL allow a person to start a stopped arm and stop a running arm. While a request is in progress the affected arm SHALL be shown in a transitional state, and conflicting controls SHALL be unavailable.

#### Scenario: Starting an arm

- **WHEN** the start control is used for a stopped arm
- **THEN** the arm is shown as starting, and then as running once it is ready

#### Scenario: Start failure is reported

- **WHEN** starting an arm fails
- **THEN** the arm is shown as failed with the reported reason, and the start control becomes available again

#### Scenario: Eviction is visible

- **WHEN** starting an arm requires stopping a running arm that holds exclusive GPU access
- **THEN** the person is informed which arm will be stopped before the operation proceeds, and both arms' states are reflected as the switch happens

### Requirement: Loss of the supervisor is surfaced explicitly

When the supervisor is unreachable, the application SHALL present that condition as a distinct state rather than reporting arms as stopped or failing requests without explanation.

#### Scenario: Supervisor is not running

- **WHEN** the arm inventory view is opened and the supervisor is unreachable
- **THEN** the application reports that the supervisor is unavailable and does not present arms as stopped

#### Scenario: Recovery without reload

- **WHEN** the supervisor becomes reachable again
- **THEN** the application resumes reporting real arm state without requiring a full page reload
