import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import { bootstrapKicadProject } from '../src/kicad/bootstrap.js';
import { draftSchematic, symLibTableRows } from '../src/kicad/draft/draft.js';
import { exportNetlist, resolveKicadCli } from '../src/kicad/cli.js';
import { expandUri, libTableRows } from '../src/kicad/libtable.js';
import { kicadLoadError, runDrc } from '../src/kicad/cli.js';
import { unroutedGuard } from '../src/capabilities/handlers.js';
import { FootprintResolver, footprintSearchDirs, formatMissingFootprints, missingFootprints } from '../src/kicad/footprints.js';
import {
  boardFootprints,
  boardMatchesNetlist,
  instantiateFootprint,
  MissingFootprintsError,
  moveFootprint,
  PadMismatchError,
  padNetMismatches,
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
let seededConfig: string;
/** Only the stock install and the project table: the machine's global table stays out. */
const hermetic = (): NodeJS.ProcessEnv => ({ ...process.env, KICAD_CONFIG_HOME: emptyConfig });
/**
 * For kicad-cli DRC: a global fp-lib-table naming every stock library, as a
 * configured KiCad has, whatever this machine's own config holds.
 */
const seeded = (): NodeJS.ProcessEnv => ({ ...process.env, KICAD_CONFIG_HOME: seededConfig });

beforeAll(async () => {
  stock = (await footprintSearchDirs())[0]!;
  emptyConfig = await mkdtemp(path.join(tmpdir(), 'copperhead-kicadcfg-'));
  seededConfig = await mkdtemp(path.join(tmpdir(), 'copperhead-kicadcfg-'));
  const version = /(\d+\.\d+)/.exec((await execa(resolveKicadCli(), ['--version'])).stdout)![1]!;
  const libs = (await readdir(stock)).filter((e) => e.endsWith('.pretty'));
  await mkdir(path.join(seededConfig, version), { recursive: true });
  await writeFile(
    path.join(seededConfig, version, 'fp-lib-table'),
    `(fp_lib_table\n\t(version 7)\n${libs
      .map((e) => `\t(lib (name "${e.slice(0, -'.pretty'.length)}")(type "KiCad")(uri "${path.join(stock, e).split(path.sep).join('/')}")(options "")(descr ""))`)
      .join('\n')}\n)\n`,
    'utf8',
  );
});
afterAll(async () => {
  await rm(emptyConfig, { recursive: true, force: true });
  await rm(seededConfig, { recursive: true, force: true });
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

describe('KiCad path variables in library tables (AC-15.30)', () => {
  it('expands ${KICAD<n>_3RD_PARTY} to its default and user variables from kicad_common.json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-pathvars-'));
    try {
      const cfg = path.join(dir, 'cfg', '10.0');
      const data = path.join(dir, 'data');
      await mkdir(cfg, { recursive: true });
      await mkdir(path.join(data, 'kicad', '10.0', '3rdparty', 'footprints', 'PCM_Espressif.pretty'), { recursive: true });
      await mkdir(path.join(dir, 'vendor', 'Mine.pretty'), { recursive: true });
      await writeFile(
        path.join(cfg, 'fp-lib-table'),
        '(fp_lib_table\n\t(version 7)\n' +
          '\t(lib (name "PCM_Espressif")(type "KiCad")(uri "${KICAD10_3RD_PARTY}/footprints/PCM_Espressif.pretty")(options "")(descr ""))\n' +
          '\t(lib (name "Mine")(type "KiCad")(uri "${MY_PARTS}/Mine.pretty")(options "")(descr ""))\n)\n',
        'utf8',
      );
      await writeFile(path.join(cfg, 'kicad_common.json'), JSON.stringify({ environment: { vars: { MY_PARTS: path.join(dir, 'vendor') } } }), 'utf8');
      const env = { HOME: dir, KICAD_CONFIG_HOME: path.join(dir, 'cfg'), XDG_DATA_HOME: data };
      const { rows } = await libTableRows('fp', { projectDir: dir, env });
      expect(rows.get('PCM_Espressif')?.uri).toBe(path.join(data, 'kicad', '10.0', '3rdparty', 'footprints', 'PCM_Espressif.pretty'));
      expect(rows.get('Mine')?.uri).toBe(path.join(dir, 'vendor', 'Mine.pretty'));
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
        env: seeded(),
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

  it('a pad moved to another net does not complete it, and populate will not keep stale nets', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await withLayoutDoc(repo);
      await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      const board = path.join(repo, PCB);
      const populated = await readFile(board, 'utf8');
      const netlist = parseNetlist(await exportNetlist(path.join(repo, SCH)));
      expect(padNetMismatches(populated, netlist)).toEqual([]);
      // R1 pad 1 re-netted by hand (what an edit_file "fix" for a short would do)
      const r1 = populated.indexOf('(property "Reference" "R1"');
      const pad = populated.indexOf('(pad "1"', r1);
      const net = populated.indexOf('(net ', pad);
      const netEnd = populated.indexOf(')', net) + 1;
      const renetted = populated.slice(0, net) + '(net 0 "")' + populated.slice(netEnd);
      await writeFile(board, renetted, 'utf8');
      expect(padNetMismatches(renetted, netlist)).toEqual([expect.stringMatching(/^R1\.1 \(no net, schematic /)]);
      expect(await layoutDraft.isComplete(repo, 'docs/')).toBe(false);
      await expect(populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() })).rejects.toThrow(
        /1 pad net\(s\) differ from the schematic/,
      );
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

  it('keeps a user row verbatim however it is laid out: multi-line, unquoted name, nested Table', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      const table = path.join(repo, 'sym-lib-table');
      const rows = [
        '(lib\n\t\t(name "UserLib")\n\t\t(type "KiCad")\n\t\t(uri "${KIPRJMOD}/lib/UserLib.kicad_sym")\n\t\t(options "")\n\t\t(descr "multi-line")\n\t)',
        '(lib (name Bare)(type KiCad)(uri "${KIPRJMOD}/lib/Bare.kicad_sym")(options "")(descr ""))',
        '(lib (name "Vendor")(type "Table")(uri "${KIPRJMOD}/vendor/sym-lib-table")(options "")(descr ""))',
      ];
      const drafted = await readFile(table, 'utf8');
      await writeFile(table, drafted.replace('(version 7)', `(version 7)\n\t${rows.join('\n\t')}`), 'utf8');
      const res = await draftSchematic({
        repoRoot: repo,
        schematic: SCH,
        intentPath: 'schematic.intent.json',
        docsDir: path.join(repo, 'docs'),
        symbolDirs: [SYMLIB],
      });
      expect(res.ok).toBe(true);
      const after = await readFile(table, 'utf8');
      for (const row of rows) expect(after).toContain(row);
      // still a table KiCad (and copperhead) can read, with each row whole
      expect(symLibTableRows(after).map((r) => r.name)).toEqual(expect.arrayContaining(['UserLib', 'Bare', 'Vendor']));
    } finally {
      await cleanup();
    }
  });

  it('refuses to rewrite a sym-lib-table it cannot parse, and leaves it as it was', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      const table = path.join(repo, 'sym-lib-table');
      const broken = '(sym_lib_table\n\t(version 7)\n\t(lib (name "UserLib")(type "KiCad")\n';
      await writeFile(table, broken, 'utf8');
      const res = await draftSchematic({
        repoRoot: repo,
        schematic: SCH,
        intentPath: 'schematic.intent.json',
        docsDir: path.join(repo, 'docs'),
        symbolDirs: [SYMLIB],
      });
      expect(res.ok).toBe(false);
      expect(res.ok ? '' : res.message).toMatch(/sym-lib-table is not a readable library table/);
      expect(await readFile(table, 'utf8')).toBe(broken);
    } finally {
      await cleanup();
    }
  });

  it('a project in a subfolder resolves a library named in the sym-lib-table beside its schematic', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-symtable-'));
    try {
      await mkdir(path.join(repo, 'hardware', 'lib'), { recursive: true });
      await cp(path.join(SYMLIB, 'CopperMCU.kicad_sym'), path.join(repo, 'hardware', 'lib', 'Espressif.kicad_sym'));
      await writeFile(
        path.join(repo, 'hardware', 'sym-lib-table'),
        '(sym_lib_table\n\t(version 7)\n\t(lib (name "Espressif")(type "KiCad")(uri "${KIPRJMOD}/lib/Espressif.kicad_sym")(options "")(descr ""))\n)\n',
        'utf8',
      );
      await expect(new SymbolSource(repo, [], false).resolve('Espressif:MCU8')).rejects.toThrow();
      const sym = await new SymbolSource(repo, [], false, path.join(repo, 'hardware')).resolve('Espressif:MCU8');
      expect(sym.pins.length).toBeGreaterThan(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
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
    await execa(resolveKicadCli(), ['pcb', 'drc', '--format', 'json', '--output', out, path.join(repo, PCB)], { reject: false, env: seeded() });
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

describe('populate edge cases (#314)', () => {
  const LEGACY = `(module R_0603_1608Metric (layer F.Cu) (tedit 5F68FEEE)
  (descr "Resistor SMD 0603")
  (attr smd)
  (fp_text reference REF** (at 0 -1.43) (layer F.SilkS)
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (fp_text value R_0603_1608Metric (at 0 1.43) (layer F.Fab)
    (effects (font (size 1 1) (thickness 0.15)))
  )
  (fp_line (start -0.8 0.4125) (end -0.8 -0.4125) (layer F.Fab) (width 0.1))
  (pad 1 smd roundrect (at -0.7875 0) (size 0.875 0.95) (layers F.Cu F.Paste F.Mask) (roundrect_rratio 0.25))
  (pad 2 smd roundrect (at 0.7875 0) (size 0.875 0.95) (layers F.Cu F.Paste F.Mask) (roundrect_rratio 0.25))
)
`;

  it('instantiates a KiCad 5 (module …) footprint that KiCad then loads', async () => {
    const fp = instantiateFootprint(LEGACY, {
      fpId: 'Legacy:R_0603_1608Metric',
      ref: 'R7',
      value: '10k',
      uuid: '00000000-0000-0000-0000-000000000007',
      at: { x: 110, y: 110 },
      path: '/x',
      sheetname: '/',
      sheetfile: 'demo.kicad_sch',
      padNet: (pad) => (pad === '1' ? [1, 'VCC'] : undefined),
    });
    expect(fp).toContain('(footprint "Legacy:R_0603_1608Metric"');
    expect(fp).toContain('(fp_text reference "R7"');
    expect(fp).toContain('(fp_text value "10k"');
    expect(fp).not.toContain('tedit');
    expect(fp).toContain('(net 1 "VCC")');
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-legacy-'));
    try {
      const board = path.join(dir, 'legacy.kicad_pcb');
      const text = `(kicad_pcb (version 20240108) (generator "pcbnew")\n\t(general (thickness 1.6))\n\t(paper "A4")\n\t(layers\n\t\t(0 "F.Cu" signal)\n\t\t(31 "B.Cu" signal)\n\t\t(44 "Edge.Cuts" user)\n\t)\n\t(net 0 "")\n\t(net 1 "VCC")\n${fp}\n)\n`;
      await writeFile(board, text, 'utf8');
      expect(await kicadLoadError(board)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /** Replace the scaffold's gr_rect outline with four Edge.Cuts lines. */
  const lineOutline = (text: string, x1: number, y1: number, x2: number, y2: number): string => {
    const start = text.indexOf('(gr_rect');
    const end = text.indexOf('\n\t)', start) + 3;
    const seg = (a: number[], b: number[], i: number): string =>
      `(gr_line (start ${a[0]} ${a[1]}) (end ${b[0]} ${b[1]}) (stroke (width 0.1) (type default)) (layer "Edge.Cuts") (uuid "00000000-0000-0000-0000-00000000000${i}"))`;
    const c = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
    return text.slice(0, start) + c.map((p, i) => seg(p, c[(i + 1) % 4]!, i)).join('\n\t') + text.slice(end);
  };

  it('packs inside an outline it cannot grow, or stops when the parts do not fit', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      const board = path.join(repo, PCB);
      const scaffold = await readFile(board, 'utf8');
      await writeFile(board, lineOutline(scaffold, 50, 60, 55, 65), 'utf8');
      await expect(populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() })).rejects.toThrow(
        /more than the 5 x 5 mm outline .* grows only a single-rectangle outline/,
      );
      await writeFile(board, lineOutline(scaffold, 50, 60, 110, 120), 'utf8');
      await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      const text = await readFile(board, 'utf8');
      const ats = [...text.matchAll(/\n\t\t\(at ([-\d.]+) ([-\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      expect(ats.length).toBe(5);
      for (const [x, y] of ats) {
        expect(x).toBeGreaterThan(50);
        expect(x).toBeLessThan(110);
        expect(y).toBeGreaterThan(60);
        expect(y).toBeLessThan(120);
      }
    } finally {
      await cleanup();
    }
  });

  it('the scaffold holds board vias to a 0.3 mm drill while footprint holes may be 0.2 mm', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-rules-'));
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await bootstrapKicadProject(repo, '# Demo board');
      const rules = await readFile(path.join(repo, 'demo-board.kicad_dru'), 'utf8');
      expect(rules).toContain(`(condition "A.Type == 'Via'")`);
      expect(rules).toContain('(constraint hole_size (min 0.3mm))');
      const board = path.join(repo, PCB);
      const text = await readFile(board, 'utf8');
      const via = '\t(via (at 105 105) (size 0.6) (drill 0.2) (layers "F.Cu" "B.Cu") (net 0) (uuid "11111111-2222-3333-4444-555555555555"))\n';
      await writeFile(board, text.slice(0, text.lastIndexOf(')')) + via + ')\n', 'utf8');
      const drc = await runDrc(board);
      expect(drc.violations.map((v) => v.type)).toContain('drill_out_of_range');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('an agent run may not raise the unrouted count (AC-15.39)', () => {
  const report = (unrouted: number) => ({ ok: true, source: 'drc' as const, violations: [], unrouted, intrinsic: [] });

  it('passes while unrouted stays at the starting count, fails when it rises', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-unrouted-'));
    try {
      const board = path.join(dir, 'b.kicad_pcb');
      await writeFile(board, 'same', 'utf8');
      const ctx = { boardAtStart: 'same' } as RunContext;
      // the board is unchanged, so the baseline is this report's own count
      expect((await unroutedGuard(ctx, board, report(8))).ok).toBe(true);
      expect(ctx.unroutedBaseline).toBe(8);
      expect((await unroutedGuard(ctx, board, report(7))).ok).toBe(true);
      const worse = await unroutedGuard(ctx, board, report(9));
      expect(worse.ok).toBe(false);
      expect(worse.violations.map((v) => v.type)).toEqual(['unrouted_increase']);
      // no board at the start (or no run context board): nothing to compare
      expect((await unroutedGuard({ boardAtStart: null } as RunContext, board, report(9))).ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('counts the starting board with KiCad when the board has changed since', async () => {
    const { repo, cleanup } = await draftedProject();
    try {
      await populateBoard({ repoRoot: repo, schematic: SCH, board: PCB, env: hermetic() });
      const board = path.join(repo, PCB);
      const populated = await readFile(board, 'utf8');
      await writeFile(board, moveFootprint(populated, 'U1', 118, 113, 90), 'utf8');
      const ctx = { boardAtStart: populated } as RunContext;
      const now = await runDrc(board);
      const guarded = await unroutedGuard(ctx, board, now);
      expect(ctx.unroutedBaseline).toBe(now.unrouted); // a move breaks no connection
      expect(guarded.violations.some((v) => v.type === 'unrouted_increase')).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
