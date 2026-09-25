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

Symbol resolution SHALL consult the project `sym-lib-table` beside the schematic (with `${KIPRJMOD}` expanded to that directory) before the stock symbol directories, skipping rows that point into copperhead's vendored cache. Drafting SHALL keep every row a user added to `sym-lib-table` verbatim, whatever its layout, when it rewrites the vendored rows, and SHALL refuse to rewrite a table it cannot parse, leaving it unchanged.

#### Scenario: Project-only symbol library resolves

- **WHEN** a symbol's library is named only in the project `sym-lib-table` and no stock directory holds it
- **THEN** the symbol resolves from the project library

#### Scenario: User rows survive a draft

- **WHEN** the user added a row to `sym-lib-table` and the schematic is drafted again
- **THEN** the row is still present, alongside the vendored rows

#### Scenario: Multi-line rows survive a draft

- **WHEN** a user row spans several lines, or names its library unquoted
- **THEN** the row is still present byte for byte after the draft, and the table still parses

#### Scenario: An unreadable table is not rewritten

- **WHEN** the `sym-lib-table` is unbalanced
- **THEN** drafting fails naming the table, and the file is unchanged

#### Scenario: Project in a subfolder

- **WHEN** the schematic lives in `hardware/` and its library is named only in `hardware/sym-lib-table`
- **THEN** the symbol resolves from that library
