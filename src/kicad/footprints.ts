import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { libTableRows } from './libtable.js';
import { parseSexp, children, isList } from './sexp.js';
import { symbolSearchDirs } from './symlib.js';

/**
 * Exact footprint resolution for the board (#314). A `Lib:Name` id resolves to
 * `Name.kicad_mod` inside the library KiCad itself would call `Lib`, and to
 * nothing else: no symbol-default package, no "similar" footprint, no other
 * library. A footprint that is not installed stops the run and the user
 * installs it; guessing one is how surrogate pads end up on a board.
 *
 * Library lookup order, as in KiCad: the project `fp-lib-table`, the user's
 * global `fp-lib-table`, then the stock install (`<dir>/<Lib>.pretty`).
 */

/**
 * Stock footprint directories, newest first. Mirrors `symbolSearchDirs`: an
 * env override is exclusive (a test or pinned library set gets only that dir),
 * otherwise the standard Linux/macOS paths, the Windows version dirs, and the
 * `footprints/` sibling of each stock symbol dir.
 */
export async function footprintSearchDirs(env = process.env, winRoot = 'C:/Program Files/KiCad'): Promise<string[]> {
  const fromEnv = [env.KICAD_FOOTPRINT_DIR, env.KICAD10_FOOTPRINT_DIR, env.KICAD9_FOOTPRINT_DIR, env.KICAD8_FOOTPRINT_DIR].filter(
    (v): v is string => !!v,
  );
  const candidates = fromEnv.length
    ? fromEnv
    : [
        '/usr/share/kicad/footprints',
        '/usr/local/share/kicad/footprints',
        '/Applications/KiCad/KiCad.app/Contents/SharedSupport/footprints',
      ];
  if (!fromEnv.length) {
    try {
      const versions = (await readdir(winRoot, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) candidates.push(`${winRoot}/${v}/share/kicad/footprints`);
      candidates.push(`${winRoot}/share/kicad/footprints`);
    } catch {
      // not a Windows install
    }
    for (const symDir of await symbolSearchDirs(env, winRoot)) candidates.push(path.join(path.dirname(symDir), 'footprints'));
  }
  const out: string[] = [];
  for (const dir of candidates) {
    try {
      await access(dir);
      if (!out.includes(dir)) out.push(dir);
    } catch {
      // not present on this machine
    }
  }
  return out;
}

export type FootprintMiss = 'bad-id' | 'no-library' | 'no-footprint';

const tokens = (s: string): string[] => s.toLowerCase().split(/[_\-.,\s]+/).filter(Boolean);

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Installed footprint names nearest a wanted one. Unlike symbol names, a
 * footprint's digits are dimensions and pitches, so a one-digit slip
 * (7351 for 7451) is the commonest mistake and must be suggested: rank by
 * shared name tokens (package family, pin count, pitch), then edit distance.
 */
export function closestFootprints(names: Iterable<string>, query: string, cap = 5): string[] {
  const q = tokens(query);
  const ql = query.toLowerCase();
  const scored: { name: string; shared: number; dist: number }[] = [];
  for (const name of names) {
    const t = new Set(tokens(name));
    const shared = q.filter((x) => t.has(x)).length;
    const dist = editDistance(ql, name.toLowerCase());
    if (shared >= Math.max(1, Math.ceil(q.length / 2)) || dist <= Math.max(2, Math.floor(ql.length / 6))) scored.push({ name, shared, dist });
  }
  scored.sort((a, b) => b.shared - a.shared || a.dist - b.dist || a.name.localeCompare(b.name));
  return scored.slice(0, cap).map((s) => s.name);
}

export type FootprintLookup =
  | { ok: true; file: string; library: string }
  | { ok: false; why: FootprintMiss; near: string[] };

export interface FootprintResolverOptions {
  /** Directory holding the `.kicad_pro` (`${KIPRJMOD}`). */
  projectDir: string;
  env?: NodeJS.ProcessEnv;
  /** Override the stock dirs (tests); defaults to `footprintSearchDirs(env)`. */
  stockDirs?: string[];
  /** Read the user's global fp-lib-table (default true). */
  global?: boolean;
}

export class FootprintResolver {
  private constructor(
    private readonly libs: Map<string, { dir: string; source: string }>,
    /** Human-readable list of what was searched, for the stop message. */
    readonly searched: string[],
  ) {}

  static async create(opts: FootprintResolverOptions): Promise<FootprintResolver> {
    const env = opts.env ?? process.env;
    const stock = opts.stockDirs ?? (await footprintSearchDirs(env));
    // KiCad's own table rows name the stock dir by a versioned variable; an
    // install that never exported it still has the dir, so fill it in.
    const defaults: Record<string, string> = {};
    if (stock[0]) for (const v of [10, 9, 8, 7]) defaults[`KICAD${v}_FOOTPRINT_DIR`] = stock[0];
    const { rows, searched } = await libTableRows('fp', {
      projectDir: opts.projectDir,
      env,
      defaults,
      ...(opts.global === undefined ? {} : { global: opts.global }),
    });
    const libs = new Map<string, { dir: string; source: string }>();
    for (const [name, row] of rows) libs.set(name, { dir: row.uri, source: row.source });
    for (const dir of stock) {
      let entries: string[] = [];
      try {
        entries = await readdir(dir);
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.endsWith('.pretty')) continue;
        const name = e.slice(0, -'.pretty'.length);
        if (!libs.has(name)) libs.set(name, { dir: path.join(dir, e), source: 'stock footprints' });
      }
    }
    if (stock.length) searched.push(`stock footprints (${stock.length} dir${stock.length > 1 ? 's' : ''})`);
    return new FootprintResolver(libs, searched);
  }

  async resolve(fpId: string): Promise<FootprintLookup> {
    const i = fpId.indexOf(':');
    const lib = i > 0 ? fpId.slice(0, i) : '';
    const name = i > 0 ? fpId.slice(i + 1) : '';
    if (!lib || !name || /[\\/]|\.\./.test(name)) return { ok: false, why: 'bad-id', near: [] };
    const entry = this.libs.get(lib);
    if (!entry) {
      // the same footprint name under another library is the likeliest slip
      const near: string[] = [];
      for (const [other, e] of this.libs) {
        try {
          await access(path.join(e.dir, `${name}.kicad_mod`));
          near.push(`${other}:${name}`);
        } catch {
          // not here
        }
        if (near.length >= 5) break;
      }
      return { ok: false, why: 'no-library', near };
    }
    const file = path.join(entry.dir, `${name}.kicad_mod`);
    try {
      await access(file);
      return { ok: true, file, library: entry.source };
    } catch {
      let names: string[] = [];
      try {
        names = (await readdir(entry.dir)).filter((f) => f.endsWith('.kicad_mod')).map((f) => f.slice(0, -'.kicad_mod'.length));
      } catch {
        // library dir listed in a table but missing on disk
      }
      return { ok: false, why: 'no-footprint', near: closestFootprints(names, name, 5).map((n) => `${lib}:${n}`) };
    }
  }
}

export interface MissingFootprint {
  ref: string;
  footprint: string;
  why: FootprintMiss | 'none';
  near: string[];
}

/** Resolve every (ref, footprint) pair; the misses, in ref order. */
export async function missingFootprints(
  parts: { ref: string; footprint: string | undefined }[],
  resolver: FootprintResolver,
): Promise<MissingFootprint[]> {
  const out: MissingFootprint[] = [];
  for (const p of parts) {
    if (!p.footprint) {
      out.push({ ref: p.ref, footprint: '', why: 'none', near: [] });
      continue;
    }
    const r = await resolver.resolve(p.footprint);
    if (!r.ok) out.push({ ref: p.ref, footprint: p.footprint, why: r.why, near: r.near });
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
}

/**
 * The stop message (AC-15.33): every missing part, what is wrong with it, and
 * exactly how to install it. No absolute paths — the message lands in logs
 * and issue reports.
 */
export function formatMissingFootprints(missing: MissingFootprint[], searched: string[], resumeAt: string): string {
  const refW = Math.max(...missing.map((m) => m.ref.length));
  const fpW = Math.max(...missing.map((m) => (m.footprint || '(none)').length));
  const lines = missing.map((m) => {
    const lib = m.footprint.slice(0, m.footprint.indexOf(':'));
    const why =
      m.why === 'none'
        ? 'no footprint assigned in BOM.md'
        : m.why === 'bad-id'
          ? 'not a Library:Footprint id'
          : m.why === 'no-library'
            ? `no library named "${lib}"`
            : `library "${lib}" has no footprint "${m.footprint.slice(lib.length + 1)}"`;
    const near = m.near.length ? `\n  ${' '.repeat(refW)}  installed: ${m.near.join(', ')}` : '';
    return `  ${m.ref.padEnd(refW)}  ${(m.footprint || '(none)').padEnd(fpW)}  ${why}${near}`;
  });
  const libs = [...new Set(missing.filter((m) => m.why === 'no-library').map((m) => m.footprint.slice(0, m.footprint.indexOf(':'))))];
  const example = libs[0] ?? 'MyLib';
  return [
    `${missing.length} footprint${missing.length > 1 ? 's are' : ' is'} not installed on this machine`,
    '',
    ...lines,
    '',
    `Install ${missing.length > 1 ? 'them' : 'it'}, or fix the Footprint cell in BOM.md, then re-run \`copperhead create\` (it resumes at ${resumeAt}):`,
    `  - project-local: put ${example}.pretty in this repo and add a row to ./fp-lib-table`,
    `      (lib (name "${example}")(type "KiCad")(uri "\${KIPRJMOD}/${example}.pretty")(options "")(descr ""))`,
    '  - or globally: KiCad > Preferences > Manage Footprint Libraries',
    `Searched: ${searched.join(', ') || 'nothing (no footprint libraries found)'}`,
  ].join('\n');
}

/** Pad numbers a footprint defines (unnumbered mechanical pads excluded). */
export function padNumbers(modText: string): Set<string> {
  const root = parseSexp(modText)[0];
  const out = new Set<string>();
  if (!root || !isList(root)) return out;
  for (const pad of children(root, 'pad')) {
    const n = pad[1];
    if (typeof n === 'string' && n !== '') out.add(n);
  }
  return out;
}

export async function footprintPadNumbers(file: string): Promise<Set<string>> {
  return padNumbers(await readFile(file, 'utf8'));
}

/**
 * A part whose symbol pins name pads its footprint does not have: KiCad's
 * "No pad found for pin" (a symbol with C/B/E pins on a SOT-23 whose pads are
 * 1/2/3). Such a pin's net would silently vanish from the board.
 */
export interface PadMismatch {
  ref: string;
  footprint: string;
  pins: string[];
  pads: string[];
}

export function formatPadMismatch(m: PadMismatch): string {
  const pads = m.pads.length > 12 ? `${m.pads.slice(0, 12).join(', ')}, …` : m.pads.join(', ');
  return `${m.ref}: pin(s) ${m.pins.join(', ')} have no pad in footprint ${m.footprint} (its pads: ${pads || 'none'})`;
}
