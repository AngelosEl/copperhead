# kicad-tooling — Delta Spec

## ADDED Requirements

### Requirement: IR footprints match the BOM

Schematic IR validation SHALL refuse a part whose `footprint` differs from its BOM.md row's Footprint cell, naming both ids and instructing the agent to copy the BOM footprint rather than substitute another package. Cells SHALL be compared after dropping markdown backticks and spacing, never after case-folding.

#### Scenario: Substituted package is refused

- **WHEN** the IR gives C1 `Capacitor_SMD:C_0402_1005Metric` and BOM.md gives `Capacitor_SMD:C_0603_1608Metric`
- **THEN** validation fails with a finding naming both ids

#### Scenario: Symbol pins without pads are refused

- **WHEN** the draft tool validates a part whose symbol pins are C/B/E and whose footprint's pads are 1/2/3
- **THEN** validation fails naming the pins and the footprint's pads, since those nets would vanish from the board

#### Scenario: Backtick styling is not a difference

- **WHEN** the BOM cell is the same id wrapped in backticks
- **THEN** validation passes

### Requirement: Project symbol libraries

Symbol resolution SHALL consult the project `sym-lib-table` (with `${KIPRJMOD}` expanded) before the stock symbol directories, skipping rows that point into copperhead's vendored cache. Drafting SHALL keep every row a user added to `sym-lib-table` when it rewrites the vendored rows.

#### Scenario: Project-only symbol library resolves

- **WHEN** a symbol's library is named only in the project `sym-lib-table` and no stock directory holds it
- **THEN** the symbol resolves from the project library

#### Scenario: User rows survive a draft

- **WHEN** the user added a row to `sym-lib-table` and the schematic is drafted again
- **THEN** the row is still present, alongside the vendored rows
