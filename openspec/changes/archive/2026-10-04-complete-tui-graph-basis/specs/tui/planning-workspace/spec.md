## ADDED Requirements

### Requirement: Traceable bounded execution basis
Project and graph details SHALL expose retained initial plans, accepted patches, exact approved authorization, native specifications and planning references. Reads SHALL return at most 20 directory items and 64 KiB per body range, preserve UTF-8 continuity, and remain within bounded body and layout caches. Missing historical bodies SHALL be explicit; current tracker text MUST NOT impersonate approval-time content.

#### Scenario: Long basis and source change
- **WHEN** the user reads a large basis body through multiple pages or its authoritative content changes
- **THEN** the original body can be read without truncation through bounded ranges, or the changed source is identified without substituting another version

#### Scenario: Missing historical text
- **WHEN** an old record has only a reference and no authoritative historical body
- **THEN** the reference remains visible and the missing body is explicit

#### Scenario: Cross-screen return
- **WHEN** the user enters basis details from the project panel or Inspector and resizes before returning
- **THEN** approved layout and navigation are retained, and original Session, selection, input and reading positions are restored

