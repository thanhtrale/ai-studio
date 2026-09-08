## Purpose

Defines what an arm is: a self-contained, independently versioned package that wraps one generation runtime and declares, in a manifest, everything the rest of the system needs to know about it.

## ADDED Requirements

### Requirement: Arms are declared by a manifest

Every arm SHALL be a directory under `arms/` containing a manifest file that declares the arm's identifier, modality, wire protocol, lifecycle mode, launch command, and resource expectations. The system SHALL treat the manifest as the sole description of an arm; no arm may require application code changes elsewhere in order to be discovered.

#### Scenario: A new arm directory is discovered

- **WHEN** a directory containing a valid manifest is added under `arms/` and discovery runs
- **THEN** the arm appears in the arm inventory with the identifier and modality declared in its manifest

#### Scenario: A directory without a manifest is ignored

- **WHEN** a directory under `arms/` contains no manifest file and discovery runs
- **THEN** the directory is skipped and no arm is registered for it

#### Scenario: Identifiers are unique

- **WHEN** two manifests declare the same arm identifier
- **THEN** discovery reports a conflict naming both directories and registers neither of the conflicting arms

### Requirement: Manifests are validated before use

The system SHALL validate every manifest against a published schema before an arm is registered. An arm whose manifest fails validation SHALL NOT be registered, and the failure SHALL NOT prevent other arms from being registered.

#### Scenario: Invalid manifest is rejected in isolation

- **WHEN** one manifest is missing a required field or declares an unknown protocol value, and other manifests are valid
- **THEN** the invalid arm is reported as invalid with the offending field named, and every valid arm is still registered

#### Scenario: Validation errors are inspectable

- **WHEN** a manifest fails validation
- **THEN** the arm inventory exposes the arm identifier, its directory, and the validation error rather than silently omitting it

### Requirement: Arms declare a wire protocol

A manifest SHALL declare which protocol its runtime speaks, from a closed set of supported values. Arms whose runtime already speaks a supported protocol SHALL require no code within the arm package.

#### Scenario: Protocol-only arm requires no code

- **WHEN** an arm package contains a manifest declaring a supported non-native protocol and contains no source files
- **THEN** the arm is registered and is startable

#### Scenario: Unsupported protocol is rejected

- **WHEN** a manifest declares a protocol value outside the supported set
- **THEN** the manifest fails validation and the arm is not registered

### Requirement: Arms declare a lifecycle mode

A manifest SHALL declare whether the arm is resident, meaning a long-running process that serves many requests, or one-shot, meaning a process started per unit of work that exits when the work completes. The declared mode SHALL determine which lifecycle guarantees apply to the arm.

#### Scenario: Resident arm requires connection details

- **WHEN** a manifest declares the resident mode
- **THEN** validation requires a health check declaration, and the launch declaration must accept an injected port

#### Scenario: One-shot arm requires neither port nor health check

- **WHEN** a manifest declares the one-shot mode without a health check or port placeholder
- **THEN** the manifest validates successfully

### Requirement: Arms declare their accepted parameters

A manifest SHALL reference a machine-readable schema describing the parameters the arm accepts. Any value substituted into the arm's launch invocation SHALL first be validated against that schema.

#### Scenario: Parameters are exposed for inspection

- **WHEN** a registered arm is queried
- **THEN** its parameter schema is returned alongside its identifier and modality

#### Scenario: Manifest references a missing schema

- **WHEN** a manifest references a parameter schema file that does not exist in the arm package
- **THEN** the manifest fails validation and the arm is not registered

### Requirement: Arm environments are mutually isolated

An arm SHALL resolve its executables, native libraries, and interpreter dependencies from within its own package directory. Two arms wrapping the same runtime at different versions, or built against different accelerator toolkit versions, SHALL be installable and runnable on the same machine without interfering with each other.

#### Scenario: Conflicting runtime versions coexist

- **WHEN** two arms wrap the same runtime built against different accelerator toolkit versions and both are registered
- **THEN** each arm, when started, loads the libraries contained in its own package directory

#### Scenario: Arm dependencies are excluded from version control

- **WHEN** an arm's binaries or interpreter environment are installed into its package directory
- **THEN** those artifacts are untracked, and only the manifest and any arm-authored source remain tracked
