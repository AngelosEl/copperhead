# fix-layout-draft-footprints: Tasks

## 1. Library tables and footprint resolution

- [x] 1.1 New `src/kicad/libtable.ts`: read `fp-lib-table`/`sym-lib-table` (project, then the newest global config dir; `KICAD_CONFIG_HOME` honored), expand `${VAR}`/`$(VAR)` with `KIPRJMOD`, follow nested `Table` rows, skip disabled and non-KiCad rows, first nickname wins
- [x] 1.2 New `src/kicad/footprints.ts`: `footprintSearchDirs` (env override exclusive, Linux/macOS paths, Windows version dirs, siblings of the stock symbol dirs); `FootprintResolver` with exact-id resolution and `KICADn_FOOTPRINT_DIR` defaults; misses carry `no-library`/`no-footprint`/`bad-id` and near ids
- [x] 1.3 `missingFootprints` and `formatMissingFootprints` (the stop message: parts, reasons, table row, install route, sources searched, resume point; no absolute paths)
- [x] 1.4 Tests: URI expansion, precedence, nested tables, disabled rows, project-only resolution, no substitution, the stop message

## 2. Board populate

- [x] 2.1 `exportNetlist` in `src/kicad/cli.ts`
- [x] 2.2 New `src/kicad/populate.ts`: `parseNetlist` (skip `#` refs and board-excluded parts; schematic paths), `instantiateFootprint` (anchored splices only), `footprintBounds` (pads, graphics, silkscreen text sized by the instance), `shelfPack`, `boardFootprints`, `boardMatchesNetlist`
- [x] 2.3 `populateBoard`: resolve all first, net codes by name, pack inside the outline (grow a lone scaffold `gr_rect`), splice net table and footprints, probe-load in a temp copy, then write; unchanged on an exact match, refused on a different set
- [x] 2.4 Tests against real kicad-cli: exact ids, pad nets equal the netlist, pad geometry byte-identical, DRC clean with schematic parity, idempotent and deterministic, missing footprint leaves the board byte-identical, project-local footprint, refusal on a mismatched board

## 3. Pipeline

- [x] 3.1 Footprint stop before the schematic stage (`bomFootprintStop`), no agent turn or diagnosis
- [x] 3.2 Populate before every layout-draft attempt (`populateStop`); stop on failure
- [x] 3.3 Layout-draft `isComplete` compares the board with the schematic; `contractGapDetail` names the difference
- [x] 3.4 Stage 5 prompt: move the populated footprints, never add or rewrite one
- [x] 3.5 Tests: the stop before the schematic stage with its message, resume after install, completion fails for outline-only, renamed, and swapped footprints

## 4. Schematic side

- [x] 4.1 `bomFootprintId` in `src/memory/bom-table.ts`; IR validation refuses an intent footprint that differs from BOM.md
- [x] 4.2 `SymbolSource` resolves from the project `sym-lib-table`; drafting keeps user rows
- [x] 4.3 Tests for both

## 5. Corpus findings

- [x] 5.1 Ran populate on the 4 reference boards and 10 real designs: every populated board DRC-clean with schematic parity; designs whose project libraries are absent stop with named parts
- [x] 5.2 Pin/pad mismatch (npn-switch Q1: C/B/E pins on SOT-23 pads 1/2/3) refused by populate and by the draft tool's IR validation
- [x] 5.3 Scaffold `min_through_hole_diameter` 0.2 mm (buck-12v-5v QFN thermal vias)
- [x] 5.4 Pack rows at least sqrt(total area) wide, so large designs grow the outline both ways
- [x] 5.5 Tests for 5.2 and 5.3

## 6. Unrouted connections

- [x] 6.1 `normalizeReport` keeps `unconnected_items` out of `violations`; `CheckReport.unrouted` counts them; `formatViolations` and `check` show the count
- [x] 6.2 Stage 5 prompt: unrouted nets are allowed and go in Draft quality
- [x] 6.3 Tests: ratsnest-only DRC is clean; a real violation still fails beside unrouted ones

## 7. Part selection verifies footprints (found in the live run)

- [x] 7.1 `bomFootprintRows`: footprints only from tables with a Footprint column, first row per refdes; the IR cross-check uses it and keeps the first BOM row per refdes
- [x] 7.2 `check_footprints` tool (query, no unlock) and footprint-aware near-name ranking
- [x] 7.3 Part-selection completion requires resolvable footprints (except an uninstalled library); gap detail lists misses with suggestions; prompt requires check_footprints
- [x] 7.4 Tests: table selection, tool output with a one-digit slip, the gate's three outcomes

## 8. Library-intrinsic DRC findings (found in the live run)

- [x] 8.1 `footprintOwner`; `normalizeReport` moves single-footprint DRC findings to `CheckReport.intrinsic`; `formatViolations`, `run_drc`, and `check` report them
- [x] 8.2 Stage 5 prompt: name them in Draft quality, never try to fix them
- [x] 8.3 Tests: same-footprint finding is clean and listed; two-part and track findings still fail

## 9. Moving footprints (found in the live run)

- [x] 9.1 `moveFootprint`: rotate pad, property, and text angles with the footprint, by anchored splices
- [x] 9.2 `move_footprint` tool (spec-gated mutation, load-probe with revert); Stage 5 prompt forbids hand-editing placement
- [x] 9.3 `normalizeReport` never excuses findings inside a footprint KiCad reports as modified
- [x] 9.4 Tests: moveFootprint rotation passes DRC with no mismatch; a hand rotation fails; the tool is gated

## 10. Spec

- [x] 10.1 SPEC.md: pipeline diagram, the one stop, the populate bullet, AC-15.29 – AC-15.38; AC-15.23/24's layout-draft clause marked superseded
