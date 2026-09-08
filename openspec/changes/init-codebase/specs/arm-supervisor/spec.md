## Purpose

Defines the service that owns arm processes: it discovers arms, starts and stops them on demand, arbitrates access to the GPU, and guarantees that stopping an arm actually returns its memory.

## ADDED Requirements

### Requirement: The supervisor runs independently of the web application

The supervisor SHALL run as a process whose lifetime is independent of the web application. Restarting, reloading, or stopping the web application SHALL NOT terminate, orphan, or lose track of any arm process.

#### Scenario: Web application restarts while an arm is running

- **WHEN** an arm is running and the web application process is restarted
- **THEN** the arm remains running and is reported as running once the web application reconnects

#### Scenario: Web application reload does not orphan processes

- **WHEN** the web application reloads repeatedly while an arm is running
- **THEN** exactly one arm process exists throughout, and it remains under supervisor control

### Requirement: The supervisor exposes an arm inventory

The supervisor SHALL expose the set of discovered arms together with each arm's current lifecycle state. States SHALL distinguish at minimum: stopped, starting, running, stopping, and failed.

#### Scenario: Inventory reflects current state

- **WHEN** the inventory is queried after an arm has been started and has passed its health check
- **THEN** that arm is reported as running and all other arms are reported as stopped

#### Scenario: Invalid arms are reported, not hidden

- **WHEN** the inventory is queried and one arm's manifest failed validation
- **THEN** that arm is included in the response marked as invalid, with its validation error

### Requirement: Starting a resident arm

On a request to start a resident arm, the supervisor SHALL allocate an unused loopback port, launch the arm's declared command with that port injected, and poll the arm's declared health check until it succeeds or the declared timeout elapses.

#### Scenario: Arm becomes healthy

- **WHEN** a stopped resident arm is started and its health check succeeds within the declared timeout
- **THEN** the arm transitions stopped, starting, running, and its allocated port is recorded

#### Scenario: Arm never becomes healthy

- **WHEN** a resident arm is started and its health check does not succeed within the declared timeout
- **THEN** the supervisor terminates the process, transitions the arm to failed, and reports the reason as a health timeout

#### Scenario: Arm exits during startup

- **WHEN** a launched arm process exits before its health check succeeds
- **THEN** the arm transitions to failed and the captured exit code and last output are retained for inspection

#### Scenario: Starting an already running arm

- **WHEN** a start is requested for an arm that is already running
- **THEN** the request succeeds without launching a second process

### Requirement: Stopping an arm reclaims its resources

On a request to stop an arm, the supervisor SHALL first request graceful termination, and SHALL forcibly terminate the arm after a grace period if it has not exited. Forced termination SHALL terminate the arm's entire process tree, including any child processes it spawned.

#### Scenario: Graceful stop

- **WHEN** a running arm is stopped and exits within the grace period
- **THEN** the arm transitions running, stopping, stopped, and its allocated port is released

#### Scenario: Unresponsive arm is force-killed

- **WHEN** a running arm does not exit within the grace period after graceful termination is requested
- **THEN** the supervisor forcibly terminates it and the arm transitions to stopped

#### Scenario: Child processes do not survive

- **WHEN** an arm that spawned child processes is stopped
- **THEN** no process descended from that arm remains running once the arm is reported as stopped

### Requirement: GPU access is arbitrated

The supervisor SHALL ensure that no more than one arm declaring exclusive GPU use is running at any time. Starting an exclusive arm while another exclusive arm is running SHALL stop the incumbent, and SHALL NOT launch the requested arm until the incumbent has fully exited.

#### Scenario: Switching modality evicts the incumbent

- **WHEN** an exclusive arm is running and a different exclusive arm is requested
- **THEN** the incumbent is stopped and confirmed exited before the requested arm is launched, and afterwards only the requested arm is running

#### Scenario: Eviction failure aborts the start

- **WHEN** an incumbent exclusive arm cannot be terminated
- **THEN** the requested arm is not launched and the request fails with a reason identifying the incumbent

#### Scenario: One-shot arms do not occupy the slot

- **WHEN** a one-shot arm completes its work and exits
- **THEN** no eviction was required to run it and the exclusive slot is unchanged

### Requirement: The supervisor reconciles orphaned processes on startup

The supervisor SHALL record enough information about each process it launches to recognise that process later. On startup, it SHALL reconcile recorded processes against processes actually running, adopting those it can identify and terminating those it cannot, before accepting any control request.

#### Scenario: Adoption after supervisor restart

- **WHEN** the supervisor restarts while an arm it previously launched is still running
- **THEN** the arm is adopted, reported as running, and can be stopped through the supervisor

#### Scenario: Unrecognised leftovers are cleared

- **WHEN** the supervisor starts and a previously recorded process is no longer identifiable as the arm that was launched
- **THEN** that record is discarded and no foreign process is terminated

### Requirement: The control interface is restricted to the local machine

The supervisor's control interface SHALL accept connections only from the loopback interface and SHALL reject any request that does not present the configured shared credential.

#### Scenario: Unauthenticated request is rejected

- **WHEN** a control request arrives without the configured credential
- **THEN** the request is rejected and no arm process is started or stopped

#### Scenario: Interface is not reachable off-host

- **WHEN** the supervisor is running
- **THEN** its control interface is bound to loopback only and is not listening on any externally routable address

### Requirement: Launch commands cannot be supplied by callers

The supervisor SHALL derive every launch command exclusively from manifests discovered on disk. It SHALL NOT accept a command, argument list, working directory, or environment from a caller. Values substituted into a launch invocation SHALL be validated against the arm's parameter schema, SHALL be placed into individual arguments rather than concatenated into a command string, and SHALL be executed without a command interpreter.

#### Scenario: Caller-supplied command is refused

- **WHEN** a control request includes a command, argument, or environment override
- **THEN** the request is rejected and nothing is executed

#### Scenario: Parameter failing its schema is refused

- **WHEN** a request supplies a parameter value that does not satisfy the arm's parameter schema
- **THEN** the request is rejected before any process is launched

#### Scenario: Path parameters cannot escape managed storage

- **WHEN** a parameter that resolves to a filesystem path points outside the managed storage directory, including via relative traversal
- **THEN** the request is rejected before any process is launched

#### Scenario: Shell metacharacters are inert

- **WHEN** a schema-valid parameter value contains shell metacharacters
- **THEN** the value is passed to the arm as a single literal argument and no interpreter expands it

### Requirement: Arms are not exposed to the browser

Ports allocated to arms SHALL be bound to the loopback interface, and SHALL NOT be disclosed to browser clients. All client traffic destined for an arm SHALL pass through the web application's server side.

#### Scenario: Arm port is withheld from clients

- **WHEN** a browser client queries the arm inventory
- **THEN** the response describes arm state without disclosing the arm's port or a directly reachable address
