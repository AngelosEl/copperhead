# create-pipeline — Delta Spec

## ADDED Requirements

### Requirement: Exact footprint resolution

A footprint id `Lib:Name` SHALL resolve only to `Name.kicad_mod` inside the library KiCad itself would call `Lib`, searching the project `fp-lib-table` (with `${KIPRJMOD}` expanded to the project directory), then the user's global `fp-lib-table` for the newest installed KiCad version (following nested `Table` rows), then the stock footprint directories. A `${KICADn_FOOTPRINT_DIR}` variable left unset SHALL default to the stock directory. Table URIs SHALL also expand `${KICADn_3RD_PARTY}` (default: KiCad's per-user `3rdparty` directory) and the user's path variables from `kicad_common.json`, with the process environment taking precedence. Resolution SHALL NOT fall back to a symbol's default footprint, a similar package, or another library.

#### Scenario: Project-only library resolves

- **WHEN** a footprint's library is named only in the project `fp-lib-table` and no `KICAD_*` variable is set
- **THEN** the footprint resolves to the file that row points at

#### Scenario: Plugin and Content Manager library resolves

- **WHEN** a global `fp-lib-table` row points at `${KICAD10_3RD_PARTY}/footprints/PCM_Espressif.pretty` and no such environment variable is set
- **THEN** the row resolves under KiCad's default `3rdparty` directory, not as a missing library

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

Before each layout-draft attempt, the pipeline SHALL place every schematic part on the board: one footprint per netlist component (power symbols and parts excluded from the board omitted), with the schematic's refdes, value, and footprint id, pad geometry byte-identical to the library file, every pad's net equal to the schematic netlist's, and a schematic path link. It SHALL write the board only after KiCad loads the result, and a board it wrote SHALL pass DRC before the agent's first turn, or the run SHALL stop, naming the findings (and a missing global `fp-lib-table` when KiCad cannot find the libraries). An unresolved footprint, or a netlist pin with no matching pad in its footprint, SHALL stop the run and leave the board byte-identical. A KiCad 5 `(module …)` library file SHALL populate like a current one. When the parts do not fit a single-rectangle outline, that outline SHALL grow roughly square; any other outline SHALL bound the pack, and a pack that does not fit it SHALL stop the run. The scaffold project SHALL allow 0.2 mm holes, which stock QFN thermal vias use, and its custom rules SHALL hold board vias to a 0.3 mm drill. A board already holding exactly the schematic's footprints on the schematic's nets SHALL be left unchanged; a board holding different footprints, or pads on other nets, SHALL be refused, not rewritten. Populating the same schematic twice SHALL produce byte-identical boards, independent of the process locale.

The populated board SHALL be the stage's own mutation: the stage's agent run SHALL count the board as touched, so finishing requires a passing `run_drc`; each retry SHALL start from the pre-stage board, re-populated; and a stage that does not complete (a stop, an abort, exhausted retries, or an error) SHALL leave the board byte-identical to the pre-stage board.

#### Scenario: Populated board matches the schematic

- **WHEN** the schematic stage has completed with every footprint installed
- **THEN** the board holds every part, and DRC with `--schematic-parity` reports no parity issue and no violation

#### Scenario: Resume on a populated board does not rewrite

- **WHEN** `create` resumes at layout-draft on a board that already holds the schematic's footprints on the schematic's nets
- **THEN** the populate step writes nothing

#### Scenario: A failed stage restores the pre-stage board

- **WHEN** the layout-draft attempt fails and the diagnosis stops the stage
- **THEN** the board is byte-identical to the board before the stage

#### Scenario: A retry starts from a fresh populate

- **WHEN** an attempt changed a footprint id and the diagnosis says retry
- **THEN** the next attempt runs on a freshly populated board instead of stopping on the changed footprint

#### Scenario: A populated board that fails DRC stops

- **WHEN** KiCad cannot find the footprint libraries because the machine has no global `fp-lib-table`
- **THEN** the run stops before any agent turn, names `lib_footprint_issues` and the missing table, and restores the board

#### Scenario: Finishing needs a DRC on the populated board

- **WHEN** the layout-draft agent run starts
- **THEN** the board counts as touched by the run, so it cannot finish without a passing `run_drc`

### Requirement: Unrouted connections are counted, not failed

DRC SHALL report unrouted connections as a count beside the result and SHALL NOT count them as violations, so a draft board whose placed and routed copper is clean passes `check` while nets remain unrouted; `check --json` SHALL carry `unrouted` and `intrinsic` counts in its `drc` object. An agent run's `run_drc` SHALL fail when the board has more unrouted connections than it had when the run started. Clearance, short, and courtyard findings SHALL still fail.

#### Scenario: Ratsnest board passes

- **WHEN** the populated board is placed but unrouted, with no other finding
- **THEN** DRC is clean and reports the unrouted count

#### Scenario: A broken connection fails the run

- **WHEN** an agent run deletes a track, leaving one more unrouted connection than the board started with
- **THEN** `run_drc` fails with an `unrouted_increase` violation

#### Scenario: A real violation still fails

- **WHEN** the board has a clearance violation and unrouted connections
- **THEN** DRC fails on the clearance violation alone

### Requirement: Library-intrinsic findings are reported, not failed

A DRC finding whose every item belongs to one footprint SHALL be reported beside the result as library-intrinsic and SHALL NOT fail the DRC gate or `check`; a finding spanning two parts, involving copper outside a footprint, putting two different nets against each other, or inside a footprint KiCad reports as modified or cannot find in its libraries SHALL still fail. The layout-draft prompt SHALL tell the agent to name such findings in Draft quality rather than try to fix them.

#### Scenario: A footprint's own hole clearance

- **WHEN** DRC reports a hole clearance between pad A1 of J1 and the NPTH peg of J1
- **THEN** DRC is clean, and the finding is listed as inside J1

#### Scenario: A short inside one footprint

- **WHEN** DRC reports a short between pad A4 [VCC] and pad B9 [GND] of J1
- **THEN** DRC fails

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

The layout-draft stage SHALL complete only when the board's (refdes, footprint id) pairs equal the schematic netlist's exactly, every pad of those parts is on its schematic netlist net, and LAYOUT.md has its `## Draft quality` section. The stage prompt SHALL tell the agent the parts are already placed and that it moves footprints and routes, never adding, deleting, or rewriting a footprint, pad, or net.

#### Scenario: Outline-only board does not complete

- **WHEN** the board has no footprints and LAYOUT.md has its Draft quality section
- **THEN** the stage is not complete

#### Scenario: A changed footprint does not complete

- **WHEN** a footprint's id or refdes on the board differs from the schematic
- **THEN** the stage is not complete, and the contract-gap detail names the difference

#### Scenario: A re-netted pad does not complete

- **WHEN** a pad's net on the board differs from the schematic netlist
- **THEN** the stage is not complete, and the contract-gap detail names the pad and both nets
