# fix-layout-draft-footprints: Proposal

## Why

Stage 5 (`layout-draft`) cannot get a single real footprint onto the board (#314). Its completion check requires `(footprint` in the board file, but no tool creates one: the agent's only path is hand-writing pad geometry into the `.kicad_pcb` for a library it cannot see. Reported runs did exactly that with surrogate pads, reached 44–75 DRC violations with library mismatches and shorts, rolled back, and ended with an outline-only board. Three independent reproductions (ESP32-C3 dev board on Windows, the USB-C breakout demo on macOS, and code reading on `main`) agree the refusal is structural, not provider-specific. `kicad-cli` 10 has no schematic-to-board update, so the step has to live in copperhead.

A second gap sits upstream: footprints are never checked before the board. IR validation only type-checks the `footprint` string, so a footprint that is not installed (the ESP32-C3-MINI-1 has no stock KiCad footprint) passes Stage 4 and fails only at the board. Project-local libraries are not read at all, which is why the reporter copied the whole stock library set into their project.

## What Changes

- **Deterministic board populate before Stage 5**: before every layout-draft attempt, the pipeline exports the schematic netlist, resolves each part's exact footprint, copies each library `.kicad_mod` onto the board by anchored text edits (refdes, value, uuid, position, schematic link, pad nets; pad geometry byte-for-byte), packs the parts on a grid inside the outline (growing the scaffold outline to fit), and writes the board only after KiCad loads it. All-or-nothing and idempotent.
- **Exact footprint resolution, KiCad's search order**: the project `fp-lib-table`, the user's global `fp-lib-table` (nested `Table` rows followed), then the stock install. No fallback to symbol defaults or similar packages.
- **Stop for the user when a footprint is not installed**: before the schematic stage, every BOM.md footprint must resolve; otherwise `create` exits naming each missing part and how to install it, and resumes once the library is added. The same stop applies at populate time. This is the pipeline's one stop that waits for a human; copperhead never downloads parts.
- **IR footprint cross-check**: the schematic IR must carry each part's BOM.md footprint verbatim, so no substitute package reaches the board unchecked.
- **Project symbol libraries**: `SymbolSource` resolves nicknames from the project `sym-lib-table`, and drafting keeps rows the user added to it.
- **Strict Stage 5 completion**: the board's (refdes, footprint id) pairs must equal the schematic's exactly. The Stage 5 prompt changes from "write geometry" to "move the populated footprints; never add or rewrite one".

## Capabilities

### Modified Capabilities

- `create-pipeline`: the footprint stop before the schematic stage, the populate step before layout-draft, the stricter layout-draft completion contract, and the Stage 5 prompt.
- `kicad-tooling`: IR validation's footprint cross-check; project `sym-lib-table` resolution; user table rows preserved.

## Impact

- **Code**: `src/kicad/libtable.ts` (new: lib-table reading), `src/kicad/footprints.ts` (new: resolver, stop message), `src/kicad/populate.ts` (new: netlist parse, instantiate, pack, atomic write, board comparison), `src/kicad/cli.ts` (`exportNetlist`), `src/kicad/draft/ir.ts`, `src/kicad/draft/symsource.ts`, `src/kicad/draft/draft.ts`, `src/memory/bom-table.ts` (`bomFootprintId`), `src/commands/create.ts`.
- **Tests**: `test/board-populate.test.ts`, `test/create-footprints.test.ts`, `test/draft-ir-bom.test.ts`. They run real `kicad-cli` like the existing ERC/DRC tests; CI already installs KiCad 10 with stock footprints.
- **Invariants**: the s-expression parser stays read-only (every board write is a splice of original text); `check`/`verify` are untouched and stay LLM-free and network-free; nothing reaches the network.
- **SPEC.md**: the pipeline diagram, the run-to-completion exception, the populate bullet, and AC-15.29 – AC-15.38 (AC-15.23/24's layout-draft clause is superseded by AC-15.38).
- **Not in scope**: updating an already-placed board after a schematic change (populate fills an empty board only), placement quality and routing (#141), and fetching parts that are not installed.
