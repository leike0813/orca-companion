## ADDED Requirements

### Requirement: Bounded native specification reading
Read-only specification browsing SHALL resolve the exact bound worktree and native unit, including archived units, and expose files and UTF-8 ranges with a proven contract revision. Tracking changes SHALL be separate from contract changes. Missing, ambiguous, changed or outside-worktree sources SHALL be refused explicitly.

#### Scenario: Native file and tracking progress
- **WHEN** an admitted unit is read after its tasks tracking changes but contract content remains unchanged
- **THEN** contract files remain bound to the admitted revision and tracking files show their actual tracking version

#### Scenario: Changed contract or escaped path
- **WHEN** contract content no longer matches the binding or the file resolves outside the bound unit/worktree
- **THEN** reading is rejected without choosing the newest unit or exposing unrelated files

