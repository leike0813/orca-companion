# Orca Companion

Orca Companion provides a dedicated coordination environment for supervising bounded software-delivery workflows while delegating project work to existing coding agents.

## Language

**Coordinator Harness**:
The Orca Companion application that runs the Coordinator Agent and exposes its constrained coordination capabilities.
_Avoid_: Worker harness, coding harness

**Coordination Scope**:
The fixed pairing of one Git repository, one full branch ref, and one user-registered canonical worktree within which Coordinator Sessions share branch-level coordination state. Coordinator Sessions cannot run from linked Worker worktrees, detached HEADs, or another branch.
_Avoid_: Current directory, commit, Worker worktree, ambient repository

**Coordinator Agent**:
The coordination role run by Orca Companion. Multiple independent Coordinator Sessions may operate within one Coordination Scope, while each supervises workflow progress and delegates project work without acting as a project worker.
_Avoid_: Planner, implementation agent, validator

**Coordinator Model Configuration**:
A user-approved configuration that binds the Coordinator Agent to a provider adapter, model, model options, credential references, and execution limits.
_Avoid_: Worker Profile, automatic routing, fallback model

**Provider Adapter**:
A LangChain chat-model integration that implements the common `BaseChatModel` interface and resolves one Coordinator Model Configuration without proxying requests or owning credentials. Companion does not maintain a provider allowlist; availability follows installed integrations and verified runtime capabilities.
_Avoid_: Companion-owned provider wrapper, provider gateway, bundled provider catalog, credential store

**Coordinator Session**:
One independently resumable LangGraph thread bound to a Coordination Scope, retaining its own coordinator conversation and loop progress across waiting, pausing, and process restarts. Coordinator Sessions never share a conversation checkpoint, and each may own at most one open Ticket Claim.
_Avoid_: Branch Coordination State, Provider session, Worker session, process lifetime

**Coordinator Session Suspension**:
The recoverable condition in which a Coordinator Session has no active model loop and awaits new Actionable Work while the Controller and Workers may continue running.
_Avoid_: Sleep, blocking wait, process shutdown, workflow pause

**Coordinator Runtime Incarnation**:
One live process execution of a Coordinator Session. A Session can have only one active incarnation at a time, while a later incarnation may resume the same durable Session after the former is fenced or exits.
_Avoid_: Coordinator Session, Coordinator Agent identity, Worker process

**Runtime Lease**:
The short, heartbeat-renewed right of one Coordinator Runtime Incarnation to execute a Coordinator Session, carrying a monotonically increasing fencing generation that rejects writes from superseded processes. Its expiry does not release the Session's Ticket Claim or Execution Coordination Lease.
_Avoid_: Ticket Claim, Execution Coordination Lease, process lifetime

**Branch Coordination State**:
The durable state shared by all Coordinator Sessions in one Coordination Scope for coordination facts that cannot be reconstructed from the issue tracker, project configuration, Git, or Orca, including the active mode and planning cycle, current graph and authorization references, shared budgets, session registrations, claims, pending interactions, operation intents, and mutation-lane state.
_Avoid_: Coordinator Session State, copied Route Map, copied Git or Orca state, workflow snapshot

**Branch Coordination Store**:
The transactional SQLite store under the repository's Git common directory that persists Branch Coordination State for concurrent Coordinator Sessions, using short transactions, unique ownership constraints, and expected revisions instead of a project-wide writer lock. It is separate from the LangGraph checkpoint database and does not mirror tracker, Git, or Orca facts.
_Avoid_: Coordinator Session checkpointer, workflow database, external-fact cache

**Route Planning Mode**:
The explicit, durable Coordination Scope mode in which independent Coordinator Sessions plan interactively with the user, may delegate bounded exploration or research to Utility Workers, and form an Execution Graph candidate for a new Graph Generation before that generation materializes any worktree, Specification Unit, or graph Work Package.
_Avoid_: Coordinator Session mode, Project-level Planner Worker, execution coordination, implementation planning phase

**Planning Cycle**:
One branch-level episode of Route Planning that produces a candidate Graph Generation, either for initial execution or after a Replanning Transition. Starting a Planning Cycle does not require a new Coordinator Session; the initiating Session may continue unless ownership is explicitly transferred.
_Avoid_: Coordinator Session, planning conversation, Graph Version

**Execution Coordination Mode**:
The explicit, durable Coordination Scope mode entered only after the initial Execution Graph exists and the user authorizes the transition; its Execution Coordination Lease holder coordinates that graph's Worker lifecycle, while later Graph Patches and Revisions are proposed through Planner Workers rather than direct Coordinator edits.
_Avoid_: Coordinator Session mode, Worker Coordination Mode, Route Planning Mode, any Worker dispatch

**Execution Coordination Lease**:
The exclusive, recoverable authority held by one Coordinator Session to mutate and advance the current Execution Graph within a Coordination Scope. Other Coordinator Sessions may observe the execution but cannot materialize tasks, consume lifecycle events, spend shared budgets, or apply graph changes.
_Avoid_: Global project lock, Worker lease, Coordinator Session ownership

**Execution Authorization Manifest**:
The complete, versioned proposal presented for one atomic user decision before a Graph Generation may execute, binding its destination and planning artifacts to an exact Coordination Scope and baseline, Worker Profiles, role authorities, budget caps, workspace policy, and accepted risks.
_Avoid_: Partial approval, per-task approval, execution status

**Execution Authorization**:
The durable record of the user's approval of one exact Execution Authorization Manifest for one Graph Generation. Entering a Replanning Transition revokes the current authorization; a candidate generation remains inert until it passes the same authorization gate with a new authorization record.
_Avoid_: Execution Authorization Manifest, Planning approval, Coordinator decision, Execution Coordination Lease

**Replanning Transition**:
The durable branch-level transition from Execution Coordination to a new Planning Cycle. It immediately blocks new dispatches and Graph Patches or Revisions, suspends the current graph topology, lets already-dispatched Workers reach a verifiable terminal state recorded only against that suspended generation, reconciles pending side effects, and then releases the Execution Coordination Lease before Route Planning begins.
_Avoid_: Graph Patch, Graph Revision, immediate Worker cancellation

**Replanning Cancellation**:
The user's explicit choice, before Generation Cutover, to discard a candidate generation's current status and resume the suspended Graph Generation after reconciling its current baseline, budget, Worker outcomes, and pending operations. The same action records the refreshed Execution Authorization and reacquires the Execution Coordination Lease; failed reconciliation leaves execution paused.
_Avoid_: Generation rollback, automatic resume, historical graph reactivation

**Replanning Baseline**:
The exact canonical-branch commit fixed after a Replanning Transition finishes reconciling old-generation work. Git establishes which code is integrated, Orca establishes accepted Worker outcomes, and old graphs, evidence, and unintegrated worktrees provide referenced planning inputs; contradictory facts block adoption instead of being guessed through.
_Avoid_: Latest branch head, old Execution Graph, copied workflow snapshot

**Unattributed Drift**:
A change to the canonical branch HEAD or worktree that cannot be reconciled to a recorded Integration Operation Intent and its accepted source. It pauses new dispatches until the Coordinator determines whether the change fits the current authorization or requires replanning.
_Avoid_: Any branch advancement, semantic defect, automatically unauthorized change

**Integration Operation**:
A Coordinator-controlled Git commit, canonical-branch integration, or configured upstream push that advances an Accepted Worker Result under the active Execution Authorization, with an expected HEAD, stable Operation Intent, and reconciled outcome.
_Avoid_: Worker self-integration, arbitrary Git shell access, force-push, deployment

**Coordinator Session State**:
The versioned, JSON-serializable conversation and loop progress persisted by the Coordinator Session's checkpointer, excluding credentials and externally authoritative workflow facts.
_Avoid_: Workflow Snapshot, business state, provider object

**Coordinator Session Recovery**:
Restoration of the same Coordinator Model Configuration, committed conversation and tool steps after interruption, followed by Runtime Lease acquisition and side-effect reconciliation before work resumes. A later Runtime Incarnation resumes the same Session; another Session requires explicit ownership transfer.
_Avoid_: Byte-level stream continuation, provider session recovery, replay without reconciliation

**Committed Model Step**:
A complete Coordinator Agent response, including its tool calls and available usage metadata, atomically accepted into Coordinator Session State.
_Avoid_: Token chunk, partial stream, displayed draft

**Wake Batch**:
A bounded, ordered admission of one or more Actionable Work source references into a Coordinator Session's durable history for one model resumption.
_Avoid_: Message queue, raw event batch, delivery acknowledgment

**Loop Stall**:
A recoverable Coordinator Session interruption raised when the graph reaches its technical recursion insurance or a node stops making observable progress.
_Avoid_: Task failure, completion signal, model-step budget

**Context Capsule**:
A derived, structured summary of an older range of Coordinator Session messages used to keep model input bounded while checkpoints retain the underlying conversation.
_Avoid_: Recovery Capsule, business state, authoritative fact

**Worker**:
An agent session delegated through Orca to perform one bounded project role using an existing coding-agent harness.
_Avoid_: Coordinator, Companion agent

**Worker Harness**:
An existing coding-agent environment, such as Codex or Claude Code, that runs a Worker and provides its model, session, and code-operation capabilities.
_Avoid_: Coordinator Harness

**Worker Role**:
The bounded responsibility assigned to a Worker, such as planning, implementation, or validation/finalization.
_Avoid_: Workflow phase

**Validator**:
A Worker that independently checks one Worker Task and may repair defects only within that task's approved scope, design, dependencies, authority, and repair budget.
_Avoid_: Finalizer, implementation worker

**Finalizer**:
An independent, read-only Worker that evaluates the whole project after task validation and returns project-level delivery evidence or blockers.
_Avoid_: Validator, last validator

**Specification Validator**:
An optional independent Worker that reviews a Specification Unit before implementation when the workflow explicitly enables that quality gate.
_Avoid_: Coordinator agent, planner self-review, implementation validator

**Validation Attempt**:
One bounded effort to validate a Worker Task; infrastructure recovery may continue it across multiple Session Segments without resetting its business budget.
_Avoid_: Model session, terminal lifetime

**Session Segment**:
One continuous Worker Harness session within a Validation Attempt, separated from the next segment by an explicit recovery handoff.
_Avoid_: Validation attempt, resumed session

**Utility Worker**:
A low-authority Worker for bounded, mechanically verifiable task kinds with explicit inputs and outputs; its model and cost are selected by a Worker Profile.
_Avoid_: General-purpose worker, coordinator, fallback validator

**Session Binding**:
A controller-validated association between one Worker Dispatch and its exact Worker Harness session and transcript source.
_Avoid_: Terminal handle, guessed latest session

**Recovery Capsule**:
A read-only Utility Worker report that compresses an interrupted Session Segment's progress, decisions, pending work, and evidence references for a replacement segment.
_Avoid_: Transcript, code snapshot, validation verdict

**Recovery Budget**:
The finite number of Session Segment reconstructions allowed within one Validation Attempt, counted separately from repair and validation attempts.
_Avoid_: Retry reset, validation budget

**Evidence Record**:
A bounded, workspace-scoped record of a command or judgment whose affected portion becomes stale after later code changes.
_Avoid_: Worker assertion, full transcript, permanent proof

**Worker Profile**:
A user-approved configuration that binds a Worker Role to its harness, model, reasoning settings, and execution limits.
_Avoid_: Coordinator choice, automatic model routing

**Dependency Policy**:
The standing authority in an Execution Authorization Manifest for Workers to add, upgrade, remove, and install project dependencies through the repository's existing package manager and configured registries within a Task Envelope and Scope Envelope.
_Avoid_: Per-package user approval, global installation, system package management, credential grant

**Task Envelope**:
The structured assignment that fixes a Worker's scope, inputs, authority, budget, and expected evidence.
_Avoid_: Prompt

**Worker Result**:
The versioned, role-specific report submitted by a Worker for controller validation.
_Avoid_: Tool call, completion message, task approval, accepted result

**Accepted Worker Result**:
The normalized Worker Result recorded only after the deterministic controller validates its task, dispatch, attempt, schema, authority, and evidence.
_Avoid_: Worker self-report, completion notice

**Baseline Adoption**:
The Coordinator Agent's structured semantic assessment that an old-generation Accepted Worker Result is represented in the Replanning Baseline and still has applicable evidence, so its delivered capability may be treated as existing code rather than copied into the new graph as a completed Work Package. The Controller validates the referenced acceptance, integration, versions, and evidence but does not decide semantic applicability; adoption never satisfies a new Work Package or transfers an old completion state.
_Avoid_: Result migration, completed-node import, evidence reuse for new work

**Migration Material**:
An old-generation result, specification, or unintegrated worktree made available as a read-only input to new work. New Work Packages always use new worktrees based on the Replanning Baseline and must explicitly migrate and revalidate any selected material.
_Avoid_: Baseline adoption, reused worktree, inherited completion

**Worker Question**:
A non-terminal request for missing input that pauses only the dependent work until the Coordinator replies to the same Worker session.
_Avoid_: Failure, new task

**Worker Escalation**:
A non-terminal request for coordination when continuing would exceed the Worker's scope, design, dependencies, authority, or budget.
_Avoid_: Worker question, task failure

**Delivery Verdict**:
The project-level deliverable-or-blocked judgment returned by an independent, read-only Finalizer and accepted by the deterministic controller.
_Avoid_: Worker completion, task validation

**Authoritative Fact**:
A durable fact owned by the issue tracker, project configuration, Git, or Orca from which the Controller reconstructs workflow state.
_Avoid_: Cached snapshot, checkpoint state

**Workflow Snapshot**:
A disposable projection of Authoritative Facts and local Control Records, including current status, violations, revision, and the ordered work that may resume.
_Avoid_: Stored workflow state, source of truth

**Actionable Work**:
An owner-scoped projection of a new Authoritative Fact or Control Record that requires Coordinator Agent judgment or a model-visible action. Raw deliveries, routine progress, keepalives, and deterministic transitions are not Actionable Work.
_Avoid_: Any event, inbox message, wake signal

**Control Record**:
A minimal Companion-owned record for information that cannot be reconstructed elsewhere, limited to side-effect intent and run-time user interaction.
_Avoid_: Workflow database, mirrored Orca state

**Execution Scope**:
The controller-issued context that binds a backend operation to its authorized workflow, caller identity, target, operation identity, and expected workflow revision.
_Avoid_: CLI flags, model-supplied identifiers, ambient terminal context

**Operation Outcome**:
The result of a backend mutation, classified as accepted, rejected, or unknown. Acceptance means the backend recorded a definite outcome, including a known execution failure; it does not confirm worker completion or workflow approval.
_Avoid_: Success boolean, task result, validation verdict

**Pending Interaction**:
A durable run-time question, answer, or one-time authorization persisted in Branch Coordination State with its owning Coordinator Session, ticket or graph scope, and expected revision. Creating one does not suspend its Session or unrelated work; any UI may submit the first valid answer, but only the owning or explicitly transferred Session may consume it.
_Avoid_: Route Map decision, Worker Profile

**Route Map**:
The shared map of a delivery effort's destination, resolved decisions, open Decision Tickets, dependencies, fog, and scope boundaries.
_Avoid_: Implementation plan, task list

**Decision Ticket**:
A bounded question or prerequisite whose resolution makes the route to the destination clearer.
_Avoid_: Worker task, implementation task

**Planning Reference**:
Any user-provided plan, specification, roadmap, task list, or free-form material that the Coordinator Agent may interpret while authoring authoritative Route Planning artifacts; it is never adopted directly, classified by a deterministic recognizer, or consumed as an executable contract.
_Avoid_: Route Map, Implementation Plan, Specification Unit, imported contract

**Ticket Claim**:
The durable, exclusive association between one open Decision Ticket and one Coordinator Session, paired with the tracker's user-visible assignee. It survives Runtime Incarnation loss and changes owner only through completion, explicit release, or user-authorized transfer.
_Avoid_: GitHub assignee alone, process lock, Worker assignment

**Frontier**:
The Decision Tickets that are open, unblocked, and unclaimed, and therefore available to work next.
_Avoid_: Backlog, all open tickets

**Implementation Plan**:
The Coordinator Agent's structured Route Planning proposal that decomposes a delivery effort into Work Package skeletons and their dependencies for deterministic graph compilation.
_Avoid_: Route map, specification unit, execution graph

**Work Package**:
A logical unit in an Execution Graph that carries one Specification Unit through planning, implementation, and validation in one worktree.
_Avoid_: Worker task, Orca task, SDD task

**Work Package Lineage**:
An explicit cross-generation reference showing that a new Work Package continues an unfinished responsibility from an old Work Package. It carries forward the old responsibility's consumed implementation, repair, and revision allowances without transferring its identity, worktree, or completion state; the Controller validates declared references rather than inferring similarity.
_Avoid_: WorkPackageId reuse, semantic matching, result adoption

**Specification Unit**:
The tool-native artifact set authored for one Work Package, such as an OpenSpec change, a Spec Kit feature, or an executable tracker ticket.
_Avoid_: Task contract, task envelope, execution graph

**Specification Provider**:
The adapter that inspects a tool-native Specification Unit and verifies role-specific artifact transitions within its worktree.
_Avoid_: Specification author, format converter, plugin loader

**Task Contract**:
The Companion-owned structured contract that fixes a Work Package's stable identity, dependencies, scope, baseline, authority, budget, acceptance evidence, and result requirements.
_Avoid_: Specification unit, prompt, task envelope

**Spec Binding**:
The versioned association between a Work Package's Task Contract and the exact Specification Unit snapshot in its worktree.
_Avoid_: Copied specification, mutable path reference

**Scope Envelope**:
The graph-level upper bound within which a Work Package's Planner may define its concrete implementation scope without requesting a Graph Revision.
_Avoid_: Exact file list, workspace boundary, worker authority

**Specification Admission**:
The deterministic acceptance of a Planner's readiness claim, Task Contract, and Spec Binding after structural, version, scope, authority, and budget checks; it does not prove semantic completeness.
_Avoid_: Specification review, semantic approval, implementation validation

**Contract Revision**:
The Specification Provider's revision of requirements, design, task descriptions, acceptance conditions, and other semantic content in a Specification Unit.
_Avoid_: Tracking revision, graph revision

**Specification Revision**:
An admitted replacement of a Work Package's contract content that preserves its identity, dependencies, and Scope Envelope.
_Avoid_: Tracking revision, graph revision, retry attempt

**Tracking Revision**:
The Specification Provider's revision of native progress markers that do not change a Specification Unit's semantic content.
_Avoid_: Contract revision, workflow status

**Execution Graph**:
The versioned logical DAG of Work Package skeletons derived before their Specification Units are authored. Companion owns its topology and reconstructs its append-only evolution from the accepted initial Implementation Plan and later accepted Graph Patch or Revision results; backend task and dispatch state are runtime projections, not duplicated graph state.
_Avoid_: Route map, Orca Task DAG, workflow engine

**Graph Generation**:
One independent, append-only Execution Graph lineage identified by its own GraphId, backed by its own Orca Run, and produced by one authorized Planning Cycle. Replanning creates a new GraphId, Run, and version sequence with predecessor references; the predecessor generation remains immutable history, and WorkPackageIds do not carry across generations.
_Avoid_: Graph Version, Graph Revision, Planning Cycle

**Generation Cutover**:
The authorization-driven replacement of the suspended Graph Generation by a candidate generation, after which the predecessor becomes immutable history and cannot be resumed. The active Planning Cycle, GraphId, Orca Run, Execution Authorization, budget reference, and Execution Coordination Lease change together or not at all; later events from the predecessor Run can complete its history but cannot affect the active generation.
_Avoid_: Replanning Transition, Graph Patch, partial activation

**Execution Frontier**:
The Work Packages whose graph dependencies have passed and whose current blockers permit their next lifecycle role to be considered for scheduling.
_Avoid_: Decision-ticket frontier, all open work packages, dispatch queue

**Dispatch Candidate**:
The single project-scoped or Work-Package-scoped Worker Task selected for possible materialization under the current lifecycle, concurrency, budget, and control state.
_Avoid_: Execution frontier, materialized task, ready worker

**Task Materialization**:
The just-in-time creation of one role-specific Orca Task for a Dispatch Candidate after its applicable lifecycle, graph, specification, worktree, authority, and budget preconditions have been checked. A Work Package's worktree is established and verified only when its first candidate is selected.
_Avoid_: Graph compilation, placeholder task, worker dispatch

**Materialization Binding**:
A disposable projection that associates one Worker Task with its validated Orca Task, reconstructed from the Task Envelope, Operation Intent, receipt, and live backend facts.
_Avoid_: Binding database, graph field, guessed task match

**Graph Patch**:
A validated, atomic set of add, revise, and retire operations appended to an Execution Graph in response to newly discovered execution information without rewriting earlier GraphVersions or runtime history.
_Avoid_: Arbitrary graph edit, task retry

**Graph Revision**:
An accepted new graph-level definition of the same Work Package in a later GraphVersion, preserving its WorkPackageId and worktree while changing its dependencies, Scope Envelope, or objective.
_Avoid_: Specification revision, patch work package, retry attempt

**Patch Work Package**:
A new Work Package and worktree added by a Graph Patch for independently plannable prerequisite work, bounded remediation, or responsibility retired from an earlier Work Package.
_Avoid_: Graph revision, revised worker task, retry attempt

**Retired Work Package**:
An unaccepted Work Package removed from the active graph by a Graph Patch because its work is obsolete or transferred to an identified Patch Work Package; its history and existing worktree remain available for audit.
_Avoid_: Accepted work package, deleted node, cancelled worker task

**Revised Worker Task**:
A new Worker Task that supersedes an earlier role assignment after a Graph Revision or Specification Revision while retaining the same WorkPackageId and worktree.
_Avoid_: Patch work package, retry attempt

**Retry Attempt**:
A new Dispatch and Attempt for the same unchanged Worker Task and Orca Task after a conclusively failed or interrupted attempt.
_Avoid_: Revised worker task, validation attempt, reconciliation

**Revision Pending**:
A scheduling hold placed on an affected Work Package after a revision or retirement need is reported while its current Worker Task is already dispatched. The current Worker runs to a verifiable terminal state, but no later role or dependent work is dispatched until the need is resolved.
_Avoid_: Worker cancellation, accepted revision, blocked project

**Baseline Reconciliation**:
A distinct Planner-profile Worker Task that reconciles an existing Work Package worktree with the accepted baseline required by a Graph Revision before revised specification work begins.
_Avoid_: Graph revision, implementation retry, controller-side merge

**Worker Task**:
A bounded, role-specific assignment that materializes as one Orca Task while advancing either the project lifecycle or one Work Package.
_Avoid_: Work package, container task, decision ticket
