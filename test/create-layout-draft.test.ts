import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execa } from 'execa';
import type { RunOptions } from '../src/agent/loop.js';
import { bootstrapKicadProject } from '../src/kicad/bootstrap.js';
import { draftSchematic } from '../src/kicad/draft/draft.js';
import { boardFootprints } from '../src/kicad/populate.js';

/**
 * The create pipeline's layout-draft stage around board populate (#314):
 * the populated board is the stage's own mutation, so a stage that does not
 * complete puts the pre-stage board back (AC-15.43), finishing needs a DRC on
 * it even when the agent never edits it, and a retry re-populates from the
 * pre-stage board instead of stopping on what the failed attempt left.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRAFT_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'draft');
const SYMLIB = path.join(ROOT, 'test', 'fixtures', 'symlib');
const SCH = 'demo-board.kicad_sch';
const PCB = 'demo-board.kicad_pcb';

type Attempt = (opts: RunOptions) => Promise<'success' | 'failure'>;
const layout = vi.hoisted(() => ({ attempts: [] as Attempt[], calls: [] as RunOptions[], boards: [] as string[] }));
const verdict = vi.hoisted(() => ({ value: 'abort' as 'retry' | 'abort' }));

vi.mock('../src/agent/loop.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  makeProvider: async () => ({ name: 'mock', close: async () => {} }),
  runAgentLoop: vi.fn(async (opts: RunOptions) => {
    if (!opts.request.includes('layout-draft')) throw new Error(`unexpected stage run: ${opts.request}`);
    layout.calls.push(opts);
    layout.boards.push(await readFile(path.join(opts.repoRoot, PCB), 'utf8'));
    const next = layout.attempts.shift();
    const outcome = next ? await next(opts) : 'failure';
    return {
      outcome,
      exitPath: outcome === 'success' ? 'done' : 'gate-failed',
      summary: 'mocked',
      transcriptDir: '',
      filesTouched: [],
      commit: null,
      stats: { turnsUsed: 1, tokensIn: 0, tokensOut: 0 },
      cacheHits: 0,
    };
  }),
}));
vi.mock('../src/agent/recovery.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  transcriptExcerpt: async () => '',
  symbolAvailabilityFacts: async () => '',
  diagnoseStageFailure: async () => ({ verdict: verdict.value, reason: 'mocked', guidance: 'mocked guidance' }),
}));
vi.mock('../src/openspec/cli.js', () => ({ openspecInit: async () => ({ ok: true, output: 'mocked' }) }));
vi.mock('../src/commands/check.js', () => ({ runCheck: async () => ({ ok: true }) }));

import { runCreate } from '../src/commands/create.js';

/**
 * A git repo whose first four stages are complete: filled SPEC/SUBSYSTEMS/BOM
 * docs and a drafted, ERC-clean schematic, so `create` resumes at layout-draft.
 */
async function projectAtLayoutDraft(): Promise<{ repo: string; brief: string; cleanup: () => Promise<void> }> {
  const repo = await mkdtemp(path.join(tmpdir(), 'copperhead-layout-'));
  await mkdir(path.join(repo, '.copperhead'), { recursive: true });
  await bootstrapKicadProject(repo, '# Demo board');
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
  await writeFile(path.join(repo, 'docs', 'SPEC.md'), '# Demo board\n\n## Budgets\n\n- sleep_current_uA: 25\n', 'utf8');
  const bom = path.join(repo, 'docs', 'BOM.md');
  await writeFile(bom, (await readFile(bom, 'utf8')).replace('| R1 | 10k | Resistor_SMD:R_0603_1608Metric | UNVERIFIED |', '| R1 | 10k | Resistor_SMD:R_0603_1608Metric | RC0603FR-0710KL |'), 'utf8');
  const brief = path.join(repo, 'brief.md');
  await writeFile(brief, '# Demo board\n', 'utf8');
  await writeFile(path.join(repo, '.gitignore'), '.env\n.copperhead/runs/\n', 'utf8');
  await execa('git', ['init', '-q'], { cwd: repo });
  await execa('git', ['config', 'user.email', 'test@copperhead.local'], { cwd: repo });
  await execa('git', ['config', 'user.name', 'copperhead-test'], { cwd: repo });
  await execa('git', ['add', '-A'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'stages 1-4'], { cwd: repo });
  return { repo, brief, cleanup: () => rm(repo, { recursive: true, force: true }) };
}

const run = (repo: string, brief: string, lines: string[] = []): ReturnType<typeof runCreate> =>
  runCreate({ repoRoot: repo, briefPath: brief, model: 'gpt-5', log: (l) => lines.push(l) });

describe('create layout-draft around board populate (#314)', () => {
  beforeEach(() => {
    // the schematic stage's completion re-drafts the IR; point it at the
    // fixture symbols the sheet was drafted from
    vi.stubEnv('KICAD_SYMBOL_DIR', SYMLIB);
    layout.attempts = [];
    layout.calls = [];
    layout.boards = [];
    verdict.value = 'abort';
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a failed stage leaves the board byte-identical to the pre-stage board (AC-15.43)', async () => {
    const { repo, brief, cleanup } = await projectAtLayoutDraft();
    try {
      const before = await readFile(path.join(repo, PCB), 'utf8');
      expect(boardFootprints(before)).toEqual([]);
      layout.attempts = [async () => 'failure'];
      const res = await run(repo, brief);
      expect(res.ok).toBe(false);
      expect(res.completed).not.toContain('layout-draft');
      // the agent ran on the populated board ...
      expect(boardFootprints(layout.boards[0]!).length).toBe(5);
      // ... and the stop put the scaffold board back
      expect(await readFile(path.join(repo, PCB), 'utf8')).toBe(before);
    } finally {
      await cleanup();
    }
  }, 180_000);

  it('the populated board counts as touched by the run, so finish needs a passing DRC on it', async () => {
    const { repo, brief, cleanup } = await projectAtLayoutDraft();
    try {
      await run(repo, brief);
      expect(layout.calls[0]?.preTouched).toEqual([PCB]);
    } finally {
      await cleanup();
    }
  }, 180_000);

  it('a populated board that fails DRC stops before any agent turn, restores the board, and says why', async () => {
    const { repo, brief, cleanup } = await projectAtLayoutDraft();
    const emptyConfig = await mkdtemp(path.join(tmpdir(), 'copperhead-kicadcfg-'));
    try {
      // no global fp-lib-table: copperhead finds the stock footprints, KiCad does not
      vi.stubEnv('KICAD_CONFIG_HOME', emptyConfig);
      const before = await readFile(path.join(repo, PCB), 'utf8');
      const lines: string[] = [];
      const res = await run(repo, brief, lines);
      expect(res.ok).toBe(false);
      expect(layout.calls).toEqual([]);
      const out = lines.join('\n');
      expect(out).toContain('the populated board fails DRC before any placement');
      expect(out).toContain('lib_footprint_issues');
      expect(out).toContain('no global fp-lib-table');
      expect(await readFile(path.join(repo, PCB), 'utf8')).toBe(before);
    } finally {
      await rm(emptyConfig, { recursive: true, force: true });
      await cleanup();
    }
  }, 180_000);

  it('a retry after an attempt that changed a footprint re-populates and runs the agent again', async () => {
    const { repo, brief, cleanup } = await projectAtLayoutDraft();
    try {
      verdict.value = 'retry';
      layout.attempts = [
        // attempt 1 swaps R1's footprint id and "succeeds": the gate fails it
        async (opts) => {
          const p = path.join(opts.repoRoot, PCB);
          const text = await readFile(p, 'utf8');
          await writeFile(p, text.replace('(footprint "Resistor_SMD:R_0603_1608Metric"', '(footprint "Resistor_SMD:R_0805_2012Metric"'), 'utf8');
          return 'success';
        },
        async () => 'failure',
      ];
      const lines: string[] = [];
      await run(repo, brief, lines);
      expect(lines.join('\n')).not.toMatch(/already has footprints that do not match/);
      expect(layout.calls.length).toBeGreaterThanOrEqual(2);
      // attempt 2 started from a freshly populated board, not attempt 1's edit
      expect(layout.boards[1]).toBe(layout.boards[0]);
    } finally {
      await cleanup();
    }
  }, 240_000);
});
