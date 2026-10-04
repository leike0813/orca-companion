## ADDED Requirements

### Requirement: Retained original compilation plan
A newly recorded initial graph SHALL retain its normalized original Implementation Plan atomically with version 1. Accepted revisions SHALL NOT replace it. Older records lacking the plan SHALL remain explicitly unavailable and MUST NOT reconstruct it from current tracker content or compiled topology.

#### Scenario: Initial record and restart
- **WHEN** a new initial graph is recorded and the process restarts
- **THEN** its exact normalized compilation plan remains readable with the original plan revision

#### Scenario: Legacy record without plan
- **WHEN** an older initial graph has no retained original plan
- **THEN** history reports the missing plan without modifying the record

