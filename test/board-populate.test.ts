import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { bootstrapKicadProject } from '../src/kicad/bootstrap.js';
import { draftSchematic } from '../src/kicad/draft/draft.js';
import { exportNetlist, resolveKicadCli } from '../src/kicad/cli.js';
import { expandUri, libTableRows } from '../src/kicad/libtable.js';
import { FootprintResolver, footprintSearchDirs, formatMissingFootprints, missingFootprints } from '../src/kicad/footprints.js';
import {
  boardFootprints,
  boardMatchesNetlist,
  MissingFootprintsError,
  moveFootprint,
  PadMismatchError,
  parseNetlist,
  populateBoard,
} from '../src/kicad/populate.js';
import { SymbolSource } from '../src/kicad/draft/symsource.js';
import { STAGES } from '../src/commands/create.js';
import { bomFootprintRows } from '../src/memory/bom-table.js';
import { normalizeReport } from '../src/kicad/report.js';
import { catalog } from '../src/capabilities/index.js';
import { dispatchTool, type RunContext } from '../src/agent/tools.js';
import { ObligationsLedger } from '../src/agent/ledger.js';

/**
 * #314: the schematic's parts reach the board with their exact footprints, or
 * the run stops for the user to install what is missing. Nothing is guessed.
 * AC-15.29 – AC-15.38.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRAFT_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'draft');
const SYMLIB = path.join(ROOT, 'test', 'fixtures', 'symlib');
const SCH = 'demo-board.kicad_sch';
const PCB = 'demo-board.kicad_pcb';

let stock: string;
let emptyConfig: string;
/** Only the stock install and the project table: the machine's global table stays out. */
const hermetic = (): NodeJS.ProcessEnv => ({ ...process.env, KICAD_CONFIG_HOME: emptyConfig });

beforeAll(async () => {
  stock = (await footprintSearchDirs())[0]!;
  emptyConfig = await mkdtemp(path.join(tmpdir(), 'copperhead-kicadcfg-'));
});
afterAll(async () => {
  await rm(emptyConfig, { recursive: true, force: true });
});

/** The drafting fixture as a create-shaped project: scaffold, then draft. */
async function draftedProject(): Promise<{ repo: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-populate-'));
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  const sch = await bootstrapKicadProject(repo, '# Demo board');
  expect(sch).toBe(SCH);
  await cp(path.join(DRAFT_FIXTURE, 'schematic.intent.json'), path.join(repo, 'schematic.intent.json'));
  await cp(path.join(DRAFT_FIXTURE, 'docs'), path.join(repo, 'docs'), { recursive: true });
  const res = await draftSchematic({
    repoRoot: repo,
    schematic: SCH,
    intentPath: 'schematic.intent.json',
    docsDir: path.join(repo, 'docs'),
    symbolDirs: [SYMLIB],
  });
  if (!res.ok) throw new Error(res.message);
  return { repo, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

/** Swap one footprint id in the drafted schematic (a Footprint property is plain text). */
async function setSchematicFootprint(repo: string, from: string, to: string): Promise<void> {
  const p = path.join(repo, SCH);
  const text = await readFile(p, 'utf8');
  expect(text).toContain(`"${from}"`);
  await writeFile(p, text.split(`"${from}"`).join(`"${to}"`), 'utf8');
}

/** A project-local library holding one stock footprint under a new name. */
async function projectLibrary(repo: string, lib: string, name: string, from: string): Promise<void> {
  const [stockLib, stockName] = from.split(':') as [string, string];
  await mkdir(path.join(repo, 'lib', `${lib}.pretty`), { recursive: true });
  await cp(path.join(stock, `${stockLib}.pretty`, `${stockName}.kicad_mod`), path.join(repo, 'lib', `${lib}.pretty`, `${name}.kicad_mod`));
  await writeFile(
    path.join(repo, 'fp-lib-table'),
    `(fp_lib_table\n\t(version 7)\n\t(lib (name "${lib}")(type "KiCad")(uri "\${KIPRJMOD}/lib/${lib}.pretty")(options "")(descr ""))\n)\n`,
    'utf8',
  );
}

describe('library tables (AC-15.30)', () => {
  it('expands ${VAR} and $(VAR), and refuses a row whose variable has no value', () => {
    expect(expandUri('${KIPRJMOD}/lib/A.pretty', { KIPRJMOD: '/p' })).toBe('/p/lib/A.pretty');
    expect(expandUri('$(HOME)/x', { HOME: '/h' })).toBe('/h/x');
    expect(expandUri('${KICAD10_FOOTPRINT_DIR}/A.pretty', {})).toBeNull();
  });

  it('reads the project table first, follows nested Table rows, and skips disabled rows', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-libtable-'));
    try {
      const cfg = path.join(dir, 'cfg', '10.0');
      await mkdir(cfg, { recursive: true });
      await mkdir(path.join(dir, 'proj'));
      await writeFile(
        path.join(dir, 'proj', 'fp-lib-table'),
        '(fp_lib_table (version 7)\n (lib (name "Mine")(type "KiCad")(uri "${KIPRJMOD}/Mine.pretty")(options "")(descr ""))\n (lib (name "Off")(type "KiCad")(uri "/x")(options "")(descr "")(disabled))\n)\n',
      );
      await writeFile(
        path.join(dir, 'template'),
        '(fp_lib_table (version 7)\n (lib (name "Stock")(type "KiCad")(uri "${KICAD10_FOOTPRINT_DIR}/Stock.pretty")(options "")(descr ""))\n (lib (name "Mine")(type "KiCad")(uri "/global/Mine.pretty")(options "")(descr ""))\n)\n',
      );
      await writeFile(
        path.join(cfg, 'fp-lib-table'),
        `(fp_lib_table (version 7)\n (lib (name "KiCad")(type "Table")(uri "${path.join(dir, 'template')}")(options "")(descr ""))\n)\n`,
      );
      const { rows, searched } = await libTableRows('fp', {
        projectDir: path.join(dir, 'proj'),
        env: { KICAD_CONFIG_HOME: path.join(dir, 'cfg') },
        defaults: { KICAD10_FOOTPRINT_DIR: '/stock' },
      });
      expect(rows.get('Mine')?.uri).toBe(path.join(dir, 'proj', 'Mine.pretty')); // project wins the clash
      expect(rows.get('Stock')?.uri).toBe('/stock/Stock.pretty'); // nested table, variable defaulted
      expect(rows.has('Off')).toBe(false);
      expect(searched).toEqual(['project fp-lib-table', 'global fp-lib-table (KiCad 10.0)']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('exact footprint resolution (AC-15.29, AC-15.30, AC-15.33)', () => {
  it('resolves a library that exists only in the project fp-lib-table, with no KICAD_* variables set', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-fpres-'));
    try {
      await projectLibrary(repo, 'Espressif', 'ESP32-C3-MINI-1', 'Resistor_SMD:R_0603_1608Metric');
      const r = await FootprintResolver.create({ projectDir: repo, env: {}, stockDirs: [], global: false });
      const hit = await r.resolve('Espressif:ESP32-C3-MINI-1');
      expect(hit).toMatchObject({ ok: true, library: 'project fp-lib-table' });
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('never substitutes: a missing library or name is a miss with suggestions, not a fallback', async () => {
    const r = await FootprintResolver.create({ projectDir: emptyConfig, env: hermetic(), global: false });
    expect(await r.resolve('Resistor_SMD:R_0603_1608Metric')).toMatchObject({ ok: true });
    const noLib = await r.resolve('Resistors:R_0603_1608Metric');
    expect(noLib).toMatchObject({ ok: false, why: 'no-library' });
    expect(noLib.ok ? [] : noLib.near).toContain('Resistor_SMD:R_0603_1608Metric');
    const noName = await r.resolve('Resistor_SMD:R_0603_1608Metrc');
    expect(noName).toMatchObject({ ok: false, why: 'no-footprint' });
    expect(noName.ok ? [] : noName.near.length).toBeGreaterThan(0);
    expect(await r.resolve('R_0603')).toMatchObject({ ok: false, why: 'bad-id' });
  });

  it('the stop message names every part, the fix, and no absolute path', async () => {
    const r = await FootprintResolver.create({ projectDir: emptyConfig, env: hermetic(), global: false });
    const missing = await missingFootprints(
      [
        { ref: 'U3', footprint: 'Espressif:ESP32-C3-MINI-1' },
        { ref: 'R1', footprint: 'Resistor_SMD:R_0603_1608Metric' },
        { ref: 'J9', footprint: '' },
      ],
      r,
    );
    expect(missing.map((m) => m.ref)).toEqual(['J9', 'U3']);
    const msg = formatMissingFootprints(missing, r.searched, 'the schematic stage');
    expect(msg).toContain('U3');
    expect(msg).toContain('no library named "Espressif"');
    expect(msg).toContain('no footprint assigned in BOM.md');
    expect(msg).toContain('(lib (name "Espressif")(type "KiCad")(uri "${KIPRJMOD}/Espressif.pretty")');
    expect(msg).toContain('re-run `copperhead create` (it resumes at the schematic stage)');
    expect(msg).not.toMatch(/\/(usr|home|tmp)\//);
  });
});

describe('board comparison (AC-15.38)', () => {
  const parts = [
    { ref: 'R1', footprint: 'Resistor_SMD:R_0603_1608Metric' },
    { ref: 'U1', footprint: 'Package_SO:SOIC-8_3.9x4.9mm_P1.27mm' },
  ];
  it('passes only on the exact set of (ref, footprint) pairs', () => {
    expect(boardMatchesNetlist(parts, parts).ok).toBe(true);
    expect(boardMatchesNetlist([], parts)).toMatchObject({ ok: false, missing: ['R1', 'U1'] });
    expect(boardMatchesNetlist([parts[0]!], parts)).toMatchObject({ ok: false, missing: ['U1'] });
    expect(boardMatchesNetlist([...parts, { ref: 'X1', footprint: 'A:B' }], parts)).toMatchObject({ ok: false, extra: ['X1'] });
    const swapped = [parts[0]!, { ref: 'U1', footprint: 'Package_SO:SOIC-8_5.3x5.3mm_P1.27mm' }];
    expect(boardMatchesNetlist(swapped, parts).ok).toBe(false);
    expect(boardMatchesNetlist(swapped, parts).changed[0]).toContain('U1');
  });
});

describe('populateBoard against kicad-cli (AC-15.36, AC-15.37)', () => {
  it('puts every part on the board with its exact footprint, pads, and nets; DRC and schematic parity are clean', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      const res = await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      expect(res.unchanged).toBe(false);
      const board = await readFile(path.join(repo, PCB), 'utf8');
      const netlist = parseNetlist(await exportNetlist(path.join(repo, SCH)));
      expect(boardMatchesNetlist(boardFootprints(board), netlist.parts).ok).toBe(true);
      expect(netlist.parts.map((p) => p.ref)).toEqual(['C1', 'J1', 'R1', 'R2', 'U1']);

      // every pad's net is the netlist's
      for (const [name, nodes] of netlist.nets) {
        for (const [ref, pin] of nodes) {
          const fp = board.slice(board.indexOf(`(property "Reference" "${ref}"`));
          const pad = fp.slice(fp.indexOf(`(pad "${pin}"`));
          expect(pad.slice(0, pad.indexOf('\n\t\t)'))).toContain(`"${name.replace(/"/g, '\\"')}")`);
        }
      }

      // pad geometry is the library's, byte-for-byte apart from the net line
      const lib = await readFile(path.join(stock, 'Package_SO.pretty', 'SOIC-8_3.9x4.9mm_P1.27mm.kicad_mod'), 'utf8');
      const libPads = lib.match(/\n\t\(pad [\s\S]*?\n\t\)/g)!;
      const flat = (s: string): string =>
        s
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => !l.startsWith('(net '))
          .join('\n');
      const boardFlat = flat(board);
      for (const p of libPads) expect(boardFlat).toContain(flat(p));

      // KiCad agrees: no violations, and the board matches the schematic
      const out = path.join(repo, 'drc.json');
      await execa(resolveKicadCli(), ['pcb', 'drc', '--schematic-parity', '--format', 'json', '--output', out, path.join(repo, PCB)], {
        reject: false,
      });
      const drc = JSON.parse(await readFile(out, 'utf8')) as { violations: unknown[]; schematic_parity: unknown[] };
      expect(drc.violations).toEqual([]);
      expect(drc.schematic_parity).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('is idempotent and deterministic: a second run writes nothing, and two fresh runs agree byte-for-byte', async () => {
    const a = await draftedProject();
    const b = await draftedProject();
    try {
      await populateBoard({ repoRoot: a.repo, schematic: SCH, board: PCB, env: hermetic() });
      await populateBoard({ repoRoot: b.repo, schematic: SCH, board: PCB, env: hermetic() });
      const first = await readFile(path.join(a.repo, PCB), 'utf8');
      expect(await readFile(path.join(b.repo, PCB), 'utf8')).toBe(first);
      const again = await populateBoard({ repoRoot: a.repo, schematic: SCH, board: PCB, env: hermetic() });
      expect(again.unchanged).toBe(true);
      expect(await readFile(path.join(a.repo, PCB), 'utf8')).toBe(first);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('a footprint that is not installed throws and leaves the board byte-identical', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await setSchematicFootprint(repo, 'Capacitor_SMD:C_0402_1005Metric', 'Espressif:ESP32-C3-MINI-1');
      const before = await readFile(path.join(repo, PCB), 'utf8');
      const err = await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MissingFootprintsError);
      expect((err as MissingFootprintsError).missing).toMatchObject([{ ref: 'C1', footprint: 'Espressif:ESP32-C3-MINI-1', why: 'no-library' }]);
      expect(await readFile(path.join(repo, PCB), 'utf8')).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it('refuses a pin its footprint has no pad for, instead of silently dropping the net', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      // a one-pad test point under a two-pin resistor: pin 2's net has nowhere to go
      await setSchematicFootprint(repo, 'Capacitor_SMD:C_0402_1005Metric', 'TestPoint:TestPoint_Pad_D1.0mm');
      const before = await readFile(path.join(repo, PCB), 'utf8');
      const err = await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PadMismatchError);
      expect((err as PadMismatchError).mismatches).toEqual([
        { ref: 'C1', footprint: 'TestPoint:TestPoint_Pad_D1.0mm', pins: ['2'], pads: ['1'] },
      ]);
      expect((err as Error).message).toContain('C1: pin(s) 2 have no pad in footprint TestPoint:TestPoint_Pad_D1.0mm (its pads: 1)');
      expect(await readFile(path.join(repo, PCB), 'utf8')).toBe(before);
    } finally {
      await cleanup();
    }
  });

  it('the scaffold allows the 0.2 mm thermal vias stock QFN footprints carry', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      const pro = JSON.parse(await readFile(path.join(repo, 'demo-board.kicad_pro'), 'utf8'));
      expect(pro.board.design_settings.rules.min_through_hole_diameter).toBe(0.2);
    } finally {
      await cleanup();
    }
  });

  it('places a footprint from a project-local library under its exact id', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await projectLibrary(repo, 'Espressif', 'Cap_Custom', 'Capacitor_SMD:C_0402_1005Metric');
      await setSchematicFootprint(repo, 'Capacitor_SMD:C_0402_1005Metric', 'Espressif:Cap_Custom');
      await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      const onBoard = boardFootprints(await readFile(path.join(repo, PCB), 'utf8'));
      expect(onBoard.find((f) => f.ref === 'C1')?.footprint).toBe('Espressif:Cap_Custom');
    } finally {
      await cleanup();
    }
  });

  it('refuses to touch a board whose footprints disagree with the schematic', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      await setSchematicFootprint(repo, 'Capacitor_SMD:C_0402_1005Metric', 'Capacitor_SMD:C_0603_1608Metric');
      const before = await readFile(path.join(repo, PCB), 'utf8');
      await expect(populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() })).rejects.toThrow(/do not match the schematic/);
      expect(await readFile(path.join(repo, PCB), 'utf8')).toBe(before);
    } finally {
      await cleanup();
    }
  });
});

describe('layout-draft completion compares the board with the schematic (AC-15.38)', () => {
  const layoutDraft = STAGES.find((s) => s.name === 'layout-draft')!;
  const withLayoutDoc = async (repo: string): Promise<void> =>
    writeFile(path.join(repo, 'docs', 'LAYOUT.md'), '# Layout\n\n## Draft quality\n\nGrid placement; route by hand.\n', 'utf8');

  it('an outline-only board never completes the stage, even with the LAYOUT.md section', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await withLayoutDoc(repo);
      expect(await layoutDraft.isComplete(repo, 'docs/')).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('the populated board completes it; a renamed or swapped footprint does not', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await withLayoutDoc(repo);
      await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      expect(await layoutDraft.isComplete(repo, 'docs/')).toBe(true);
      const board = path.join(repo, PCB);
      const populated = await readFile(board, 'utf8');
      await writeFile(board, populated.replace('(property "Reference" "C1"', '(property "Reference" "C9"'), 'utf8');
      expect(await layoutDraft.isComplete(repo, 'docs/')).toBe(false); // C1 missing, C9 extra
      await writeFile(
        board,
        populated.replace('(footprint "Capacitor_SMD:C_0402_1005Metric"', '(footprint "Capacitor_SMD:C_0603_1608Metric"'),
        'utf8',
      );
      expect(await layoutDraft.isComplete(repo, 'docs/')).toBe(false); // footprint changed
    } finally {
      await cleanup();
    }
  });
});

describe('project symbol libraries (AC-15.31)', () => {
  it('a symbol library named only in the project sym-lib-table resolves', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-symtable-'));
    try {
      await mkdir(path.join(repo, 'lib'));
      await cp(path.join(SYMLIB, 'CopperMCU.kicad_sym'), path.join(repo, 'lib', 'Espressif.kicad_sym'));
      await writeFile(
        path.join(repo, 'sym-lib-table'),
        '(sym_lib_table\n\t(version 7)\n\t(lib (name "Espressif")(type "KiCad")(uri "${KIPRJMOD}/lib/Espressif.kicad_sym")(options "")(descr ""))\n)\n',
        'utf8',
      );
      // no stock dirs at all: only the project table can answer
      const sym = await new SymbolSource(repo, [], false).resolve('Espressif:MCU8');
      expect(sym.pins.length).toBeGreaterThan(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('drafting keeps the rows a user added to sym-lib-table', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      const table = path.join(repo, 'sym-lib-table');
      const userRow = '(lib (name "Espressif")(type "KiCad")(uri "${KIPRJMOD}/lib/Espressif.kicad_sym")(options "")(descr ""))';
      const drafted = await readFile(table, 'utf8');
      await writeFile(table, drafted.replace('(version 7)', `(version 7)\n\t${userRow}`), 'utf8');
      const res = await draftSchematic({
        repoRoot: repo,
        schematic: SCH,
        intentPath: 'schematic.intent.json',
        docsDir: path.join(repo, 'docs'),
        symbolDirs: [SYMLIB],
      });
      expect(res.ok).toBe(true);
      const after = await readFile(table, 'utf8');
      expect(after).toContain(userRow);
      expect(after).toContain('copperhead vendored'); // the vendored rows are still written
    } finally {
      await cleanup();
    }
  });
});

describe('part selection verifies footprints (#314)', () => {
  const BOM = (fp: string): string =>
    '# BOM\n\n| Refdes | Value | Footprint | MPN | Rationale |\n|---|---|---|---|---|\n' +
    `| R1 | 10k | \`Resistor_SMD:R_0603_1608Metric\` | RC0603FR-0710KL | bias |\n| F1 | 4A | ${fp} | 2920L400 | fuse |\n\n` +
    '## Pins\n\n| Refdes | lib_id | Pins used |\n|---|---|---|\n| F1 | Device:Fuse | 1=VBUS,2=VOUT |\n\n' +
    '## Cost\n\n| Refdes | Qty | Cost |\n|---|---|---|\n| R1 | 1 | $0.01 |\n';

  it('reads footprints only from tables with a Footprint column, first row per refdes', () => {
    expect(bomFootprintRows(BOM('Fuse:Fuse_2920_7451Metric'))).toEqual([
      { refdes: 'R1', footprint: 'Resistor_SMD:R_0603_1608Metric' },
      { refdes: 'F1', footprint: 'Fuse:Fuse_2920_7451Metric' },
    ]);
  });

  it('check_footprints answers OK or the reason with the closest installed ids', async () => {
    const ctx = {
      repoRoot: emptyConfig,
      config: {} as RunContext['config'],
      transcript: { event: async () => {} } as unknown as RunContext['transcript'],
      ledger: new ObligationsLedger(),
      runId: 'test',
      interactive: false,
      confirm: async () => true,
      editsUnlocked: false,
      changeId: null,
      proposalValidated: false,
      filesTouched: new Set(),
      decisions: [],
      lastErc: null,
      lastDrc: null,
      lastLegibility: null,
      lastScore: null,
      repairCycles: 0,
      finishRequest: null,
    } as RunContext;
    const out = JSON.stringify(
      await dispatchTool(ctx, 'check_footprints', { footprints: ['Fuse:Fuse_2920_7451Metric', 'Fuse:Fuse_2920_7351Metric'] }),
    );
    expect(out).toContain('OK  Fuse:Fuse_2920_7451Metric');
    expect(out).toContain('MISS Fuse:Fuse_2920_7351Metric: library \\"Fuse\\" has no such footprint; installed: Fuse:Fuse_2920_7451Metric');
  });

  it('a made-up footprint keeps part selection open for the model; an uninstalled library is left to the stop', async () => {
    const partSelection = STAGES.find((s) => s.name === 'part-selection')!;
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-partsel-'));
    try {
      await mkdir(path.join(repo, 'docs'));
      await writeFile(path.join(repo, 'docs', 'BOM.md'), BOM('Fuse:Fuse_2920_7351Metric'), 'utf8');
      expect(await partSelection.isComplete(repo, 'docs/')).toBe(false); // invented name: the model fixes it
      await writeFile(path.join(repo, 'docs', 'BOM.md'), BOM('Fuse:Fuse_2920_7451Metric'), 'utf8');
      expect(await partSelection.isComplete(repo, 'docs/')).toBe(true);
      await writeFile(path.join(repo, 'docs', 'BOM.md'), BOM('Espressif:ESP32-C3-MINI-1'), 'utf8');
      expect(await partSelection.isComplete(repo, 'docs/')).toBe(true); // not installed: the run stops for the user next
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('moving placed footprints (#314)', () => {
  /** KiCad DRC on the board, through copperhead's own report normalizer. */
  async function drc(repo: string) {
    const out = path.join(repo, 'drc.json');
    await execa(resolveKicadCli(), ['pcb', 'drc', '--format', 'json', '--output', out, path.join(repo, PCB)], { reject: false });
    const raw = JSON.parse(await readFile(out, 'utf8')) as { violations: { type: string }[] };
    return { raw, report: normalizeReport(raw, 'drc') };
  }

  it('rotating with moveFootprint turns the pads too: the part still matches its library', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      const board = path.join(repo, PCB);
      const populated = await readFile(board, 'utf8');
      // open space at the bottom-right of the 30x20 scaffold outline
      await writeFile(board, moveFootprint(moveFootprint(populated, 'U1', 118, 113, 90), 'C1', 108, 116, 270), 'utf8');
      const moved = await drc(repo);
      expect(moved.raw.violations.filter((v) => v.type === 'lib_footprint_mismatch')).toEqual([]);
      expect(moved.report.intrinsic).toEqual([]);
      const u1 = boardFootprints(await readFile(board, 'utf8')).find((f) => f.ref === 'U1');
      expect(u1?.footprint).toBe('Package_SO:SOIC-8_3.9x4.9mm_P1.27mm');

      // the naive edit — only the footprint's own angle — is what KiCad calls a modified footprint,
      // and its internal findings are then NOT excused as library-intrinsic
      const i = populated.indexOf('(property "Reference" "U1"');
      const at = populated.indexOf('(at ', populated.lastIndexOf('(footprint ', i));
      const naive = populated.slice(0, at) + '(at 118 113 90)' + populated.slice(populated.indexOf(')', at) + 1);
      await writeFile(board, naive, 'utf8');
      const hand = await drc(repo);
      expect(hand.raw.violations.some((v) => v.type === 'lib_footprint_mismatch')).toBe(true);
      expect(hand.report.ok).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('is a spec-gated mutation tool, like edit_file', () => {
    const tool = catalog.find((t) => t.schema.name === 'move_footprint') as { gate?: (ctx: { editsUnlocked: boolean }) => boolean } | undefined;
    expect(tool?.gate?.({ editsUnlocked: false })).toBe(false);
    expect(tool?.gate?.({ editsUnlocked: true })).toBe(true);
  });

  it('refuses an unknown refdes', () => {
    expect(() => moveFootprint('(kicad_pcb\n)', 'X9', 0, 0)).toThrow(/no footprint with refdes X9/);
  });
});
