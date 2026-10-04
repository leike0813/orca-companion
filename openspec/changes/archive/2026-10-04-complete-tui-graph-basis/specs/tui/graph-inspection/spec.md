## ADDED Requirements

### Requirement: All-generation read-only graph history
Inspector and project details SHALL expose paged graph versions across every generation of the current Scope, including frozen generations. Each selected version SHALL show its exact graph identity, generation, topology and basis. Historical views MUST NOT borrow current runtime state or acceptance counts.

#### Scenario: Frozen generation and return
- **WHEN** the user opens an older generation and follows its node relations, then returns
- **THEN** the historical topology is exact and read-only, and the original current selection, tab, scroll, draft and reading anchor are preserved

#### Scenario: Retired selection
- **WHEN** a selected package is retired by an accepted patch
- **THEN** its retirement is explicit and history remains reachable without selecting another package automatically

### Requirement: Bounded historical navigation
Version directories SHALL return at most 20 items per page. Reading SHALL use exact source identities and versions; late results MUST NOT replace another Session or page. Rendering, resizing and navigation MUST NOT modify coordination state.

#### Scenario: Append while reading
- **WHEN** another version is appended while an immutable historical body is being paged
- **THEN** continuation remains attached to the original version and does not become stale merely because the Scope changed

