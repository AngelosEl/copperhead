# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: Exact footprint resolution

A footprint id `Lib:Name` SHALL resolve only to `Name.kicad_mod` inside the library KiCad itself would call `Lib`, searching the project `fp-lib-table` (with `${KIPRJMOD}` expanded to the project directory), then the user's global `fp-lib-table` for the newest installed KiCad version (following nested `Table` rows), then the stock footprint directories. A `${KICADn_FOOTPRINT_DIR}` variable left unset SHALL default to the stock directory. Resolution SHALL NOT fall back to a symbol's default footprint, a similar package, or another library.

#### Scenario: Project-only library resolves

- **WHEN** a footprint's library is named only in the project `fp-lib-table` and no `KICAD_*` variable is set
- **THEN** the footprint resolves to the file that row points at

#### Scenario: A miss is never substituted

- **WHEN** the library is not installed, or the library lacks the named footprint
- **THEN** resolution fails with the reason and the closest installed ids, and no other footprint is used

### Requirement: The run stops for an uninstalled footprint

Before the schematic stage's first agent turn, every BOM.md Footprint cell SHALL resolve. When any does not, `create` SHALL exit non-zero without a model turn, a retry diagnosis, or a KiCad write, and print a message naming every unresolved part (refdes, requested id, whether the library or only the footprint is missing, and the closest installed names), the `fp-lib-table` row to add, the global install route, the sources searched, and that re-running `create` resumes. The message SHALL NOT contain an absolute path. A placeholder cell (`-`, `N/A`, `TBD`, empty) SHALL be reported as unassigned.

#### Scenario: Missing module footprint stops the run

- **WHEN** BOM.md names `Espressif:ESP32-C3-MINI-1` and no `Espressif` library is installed
- **THEN** `create` stops before the schematic stage, and the message names U3, `no library named "Espressif"`, and the row to add

#### Scenario: Resume after install

- **WHEN** the user adds the library to the project `fp-lib-table` and re-runs `create`
- **THEN** the completed stages are skipped and the schematic stage runs

### Requirement: Part selection verifies footprints

The `check_footprints` tool SHALL resolve footprint ids exactly as the board populate does and, on a miss, name the reason and the closest installed ids, ranking shared name tokens before edit distance so a one-digit dimension slip is suggested. Part selection SHALL complete only when every Footprint cell of a BOM.md table that has a Footprint column resolves, except a library installed nowhere; a mistyped or invented id SHALL reopen the stage for the model with the suggestions, so only an uninstalled library reaches the stop for the user.

#### Scenario: Invented footprint goes back to the model

- **WHEN** BOM.md gives F1 `Fuse:Fuse_2920_7351Metric` and the installed footprint is `Fuse:Fuse_2920_7451Metric`
- **THEN** part selection is not complete, and the gap detail and `check_footprints` both name `Fuse:Fuse_2920_7451Metric`

#### Scenario: Supporting tables are not read as footprints

- **WHEN** BOM.md also has a pin-assignment or cost table whose rows repeat refdes
- **THEN** only the table with a Footprint column supplies footprints, and its row wins for each refdes

### Requirement: Board populate before layout-draft

Before each layout-draft attempt, the pipeline SHALL place every schematic part on the board: one footprint per netlist component (power symbols and parts excluded from the board omitted), with the schematic's refdes, value, and footprint id, pad geometry byte-identical to the library file, every pad's net equal to the schematic netlist's, and a schematic path link. It SHALL write the board only after KiCad loads the result. An unresolved footprint, or a netlist pin with no matching pad in its footprint, SHALL stop the run and leave the board byte-identical. When the parts do not fit the outline, the scaffold outline SHALL grow roughly square. The scaffold project SHALL allow 0.2 mm holes, which stock QFN thermal vias use. A board already holding exactly the schematic's footprints SHALL be left unchanged; a board holding different footprints SHALL be refused, not rewritten. Populating the same schematic twice SHALL produce byte-identical boards.

#### Scenario: Populated board matches the schematic

- **WHEN** the schematic stage has completed with every footprint installed
- **THEN** the board holds every part, and DRC with `--schematic-parity` reports no parity issue and no violation

#### Scenario: Retry does not rewrite

- **WHEN** a layout-draft attempt is retried or resumed on a board whose footprints the agent has moved
- **THEN** the populate step writes nothing

### Requirement: Unrouted connections are counted, not failed

DRC SHALL report unrouted connections as a count beside the result and SHALL NOT count them as violations, so a draft board whose placed and routed copper is clean passes the DRC gate and `check` while nets remain unrouted. Clearance, short, courtyard, and schematic-parity findings SHALL still fail.

#### Scenario: Ratsnest board passes

- **WHEN** the populated board is placed but unrouted, with no other finding
- **THEN** DRC is clean and reports the unrouted count

#### Scenario: A real violation still fails

- **WHEN** the board has a clearance violation and unrouted connections
- **THEN** DRC fails on the clearance violation alone

### Requirement: Library-intrinsic findings are reported, not failed

A DRC finding whose every item belongs to one footprint SHALL be reported beside the result as library-intrinsic and SHALL NOT fail the DRC gate or `check`; a finding spanning two parts or involving copper outside a footprint SHALL still fail. The layout-draft prompt SHALL tell the agent to name such findings in Draft quality rather than try to fix them.

#### Scenario: A footprint's own hole clearance

- **WHEN** DRC reports a hole clearance between pad A1 of J1 and the NPTH peg of J1
- **THEN** DRC is clean, and the finding is listed as inside J1

#### Scenario: Clearance between two parts

- **WHEN** DRC reports a clearance between a pad of J1 and a pad of R1
- **THEN** DRC fails

### Requirement: Footprints move with their pads

Layout SHALL place parts with a `move_footprint` tool (refdes, x, y, optional absolute rotation), gated on a validated proposal like `edit_file`, which rewrites the footprint's placement and adds the rotation change to every pad, property, and text angle, since KiCad stores those as absolute. The layout-draft prompt SHALL forbid hand-editing a footprint's placement. A DRC finding inside a footprint that KiCad reports as not matching its library SHALL NOT be excused as library-intrinsic.

#### Scenario: Rotated part still matches its library

- **WHEN** U1 is rotated 90 degrees with `move_footprint`
- **THEN** DRC reports no `lib_footprint_mismatch` and no finding inside U1

#### Scenario: A hand rotation is caught

- **WHEN** only the footprint's own angle is edited
- **THEN** DRC reports `lib_footprint_mismatch`, the findings inside the part fail, and the stage cannot finish

### Requirement: Strict layout-draft completion

The layout-draft stage SHALL complete only when the board's (refdes, footprint id) pairs equal the schematic netlist's exactly and LAYOUT.md has its `## Draft quality` section. The stage prompt SHALL tell the agent the parts are already placed and that it moves footprints and routes, never adding, deleting, or rewriting a footprint, pad, or net.

#### Scenario: Outline-only board does not complete

- **WHEN** the board has no footprints and LAYOUT.md has its Draft quality section
- **THEN** the stage is not complete

#### Scenario: A changed footprint does not complete

- **WHEN** a footprint's id or refdes on the board differs from the schematic
- **THEN** the stage is not complete, and the contract-gap detail names the difference
