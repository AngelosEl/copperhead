import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSexp, children, child, isList, type SexpNode } from './sexp.js';
import { exportNetlist, kicadLoadError } from './cli.js';
import { uuidv5 } from './emit.js';
import {
  FootprintResolver,
  formatPadMismatch,
  missingFootprints,
  padNumbers,
  type MissingFootprint,
  type PadMismatch,
} from './footprints.js';

/**
 * Board populate for the layout-draft stage (#314): the deterministic step
 * between a verified schematic and an agent that places parts. It reads the
 * schematic's KiCad netlist, resolves every part's exact footprint, copies
 * each `.kicad_mod` onto the board with anchored text edits (refdes, value,
 * uuid, position, schematic link, pad nets — never regenerated geometry),
 * packs them on a grid inside the outline, and writes the board only after
 * KiCad loads the result. Any unresolved part aborts before a byte is written.
 *
 * The s-expression parser stays read-only (SPEC §1.3): it is used to read the
 * netlist, board, and footprint bounds; every write is a splice of original
 * source text.
 */

export interface NetlistPart {
  ref: string;
  value: string;
  footprint: string;
  /** Schematic symbol path, `/<sheet uuids…>/<symbol uuid>`. */
  path: string;
  sheetname: string;
  sheetfile: string;
}

export interface Netlist {
  parts: NetlistPart[];
  /** net name → [ref, pin] endpoints. */
  nets: Map<string, [string, string][]>;
}

const atom = (node: SexpNode[] | undefined, idx: number): string | undefined => {
  const v = node?.[idx];
  return typeof v === 'string' ? v : undefined;
};

/** Board-bound parts and nets from a kicadsexpr netlist. */
export function parseNetlist(text: string): Netlist {
  const root = parseSexp(text)[0];
  const parts: NetlistPart[] = [];
  const nets = new Map<string, [string, string][]>();
  if (!root || !isList(root)) return { parts, nets };
  for (const comp of children(child(root, 'components') ?? [], 'comp')) {
    const ref = atom(child(comp, 'ref'), 1) ?? '';
    // power flags and other virtual symbols carry `#` refs and never reach a board
    if (!ref || ref.startsWith('#')) continue;
    const props = new Map<string, string>();
    for (const p of children(comp, 'property')) {
      const name = atom(child(p, 'name'), 1);
      if (name) props.set(name, atom(child(p, 'value'), 1) ?? '');
    }
    if (props.has('exclude_from_board')) continue;
    const sheetTstamps = atom(child(child(comp, 'sheetpath') ?? [], 'tstamps'), 1) ?? '/';
    const tstamp = atom(child(comp, 'tstamps'), 1) ?? atom(child(comp, 'tstamp'), 1) ?? '';
    parts.push({
      ref,
      value: atom(child(comp, 'value'), 1) ?? '',
      footprint: atom(child(comp, 'footprint'), 1) ?? '',
      path: `${sheetTstamps.endsWith('/') ? sheetTstamps : sheetTstamps + '/'}${tstamp}`,
      sheetname: props.get('Sheetname') ?? '',
      sheetfile: props.get('Sheetfile') ?? '',
    });
  }
  const boardRefs = new Set(parts.map((p) => p.ref));
  for (const net of children(child(root, 'nets') ?? [], 'net')) {
    const name = atom(child(net, 'name'), 1);
    if (!name) continue;
    const nodes: [string, string][] = [];
    for (const n of children(net, 'node')) {
      const ref = atom(child(n, 'ref'), 1);
      const pin = atom(child(n, 'pin'), 1);
      if (ref && pin && boardRefs.has(ref)) nodes.push([ref, pin]);
    }
    if (nodes.length) nets.set(name, nodes);
  }
  parts.sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  return { parts, nets };
}

// ---- source-text spans ------------------------------------------------------

interface Span {
  start: number;
  /** exclusive */
  end: number;
  tag: string;
}

/** End (exclusive) of the list opening at `open`, honoring quoted strings. */
function listEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i + 1;
  }
  throw new Error('unbalanced s-expression');
}

/** Direct child lists of the list opening at `open`. */
function childSpans(text: string, open: number): Span[] {
  const end = listEnd(text, open);
  const out: Span[] = [];
  for (let i = open + 1; i < end - 1; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < end && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '(') {
      const e = listEnd(text, i);
      out.push({ start: i, end: e, tag: /^\(\s*([^\s()"]+)/.exec(text.slice(i, i + 64))?.[1] ?? '' });
      i = e - 1;
    }
  }
  return out;
}

const q = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const num = (n: number): string => String(Math.round(n * 1e4) / 1e4);

// ---- footprint geometry -----------------------------------------------------

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Everything the footprint draws: pads, graphics on every layer (courtyard
 * included), and visible silkscreen text sized by the instance's own refdes
 * and value, so a packed neighbour or the board edge never clips its silk.
 */
export function footprintBounds(modText: string, labels: { ref?: string; value?: string } = {}): Bounds {
  const root = parseSexp(modText)[0];
  const all: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (b: Bounds, x: number, y: number): void => {
    b.minX = Math.min(b.minX, x);
    b.minY = Math.min(b.minY, y);
    b.maxX = Math.max(b.maxX, x);
    b.maxY = Math.max(b.maxY, y);
  };
  const xy = (n: SexpNode[] | undefined): [number, number] | null =>
    n ? [parseFloat(atom(n, 1) ?? 'NaN'), parseFloat(atom(n, 2) ?? 'NaN')] : null;
  if (!root || !isList(root)) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  for (const item of root) {
    if (!isList(item)) continue;
    const tag = item[0];
    if (tag === 'pad') {
      const at = xy(child(item, 'at'));
      const size = xy(child(item, 'size'));
      if (!at || !size) continue;
      const r = Math.max(size[0], size[1]) / 2; // rotation-safe
      grow(all, at[0] - r, at[1] - r);
      grow(all, at[0] + r, at[1] + r);
      continue;
    }
    if (tag === 'property' || tag === 'fp_text') {
      const hidden = atom(child(item, 'hide'), 1) === 'yes' || item.includes('hide') || child(child(item, 'effects') ?? [], 'hide');
      const at = xy(child(item, 'at'));
      const size = xy(child(child(child(item, 'effects') ?? [], 'font') ?? [], 'size'));
      const layer = atom(child(item, 'layer'), 1) ?? '';
      const kind = (atom(item, 1) ?? '').toLowerCase();
      const label = kind === 'reference' ? (labels.ref ?? atom(item, 2)) : kind === 'value' ? (labels.value ?? atom(item, 2)) : atom(item, 2);
      if (hidden || !at || !size || !label || !layer.endsWith('.SilkS')) continue;
      // a rough box: KiCad's stroke font is about 0.8 x height per glyph
      const half = { w: (label.length * size[0] * 0.8) / 2, h: size[1] / 2 };
      grow(all, at[0] - half.w, at[1] - half.h);
      grow(all, at[0] + half.w, at[1] + half.h);
      continue;
    }
    if (typeof tag !== 'string' || !/^fp_(line|rect|circle|arc|poly)$/.test(tag)) continue;
    const pts: [number, number][] = [];
    for (const k of ['start', 'mid', 'end']) {
      const p = xy(child(item, k));
      if (p) pts.push(p);
    }
    for (const p of children(child(item, 'pts') ?? [], 'xy')) {
      const v = xy(p);
      if (v) pts.push(v);
    }
    const center = xy(child(item, 'center'));
    if (tag === 'fp_circle' && center && pts[0]) {
      const r = Math.hypot(pts[0][0] - center[0], pts[0][1] - center[1]);
      pts.push([center[0] - r, center[1] - r], [center[0] + r, center[1] + r]);
    }
    for (const [x, y] of pts) if (Number.isFinite(x) && Number.isFinite(y)) grow(all, x, y);
  }
  return Number.isFinite(all.minX) ? all : { minX: -1, minY: -1, maxX: 1, maxY: 1 };
}

// ---- instantiation ----------------------------------------------------------

export interface Instance {
  fpId: string;
  ref: string;
  value: string;
  uuid: string;
  at: { x: number; y: number };
  path: string;
  sheetname: string;
  sheetfile: string;
  /** pad number → [net code, net name] */
  padNet: (pad: string) => [number, string] | undefined;
}

/**
 * A library `.kicad_mod` as a board footprint. Library-only header lines
 * (version, generator) are dropped; the id, refdes, value, uuid, placement,
 * schematic link, and pad nets are spliced into the original text. Pad and
 * graphic geometry is carried over byte-for-byte.
 */
export function instantiateFootprint(modText: string, inst: Instance): string {
  const open = modText.indexOf('(footprint');
  if (open < 0) throw new Error(`${inst.fpId}: not a footprint file`);
  const parts: string[] = [`(footprint ${q(inst.fpId)}`];
  let placed = false;
  const placement = [
    `(uuid ${q(inst.uuid)})`,
    `(at ${num(inst.at.x)} ${num(inst.at.y)})`,
  ];
  for (const s of childSpans(modText, open)) {
    let t = modText.slice(s.start, s.end);
    if (s.tag === 'version' || s.tag === 'generator' || s.tag === 'generator_version' || s.tag === 'uuid' || s.tag === 'at') continue;
    if (s.tag === 'property' || s.tag === 'fp_text') {
      t = t
        .replace(/^\(property\s+"Reference"\s+"(?:[^"\\]|\\.)*"/, `(property "Reference" ${q(inst.ref)}`)
        .replace(/^\(property\s+"Value"\s+"(?:[^"\\]|\\.)*"/, `(property "Value" ${q(inst.value)}`)
        .replace(/^\(fp_text\s+reference\s+"(?:[^"\\]|\\.)*"/, `(fp_text reference ${q(inst.ref)}`)
        .replace(/^\(fp_text\s+value\s+"(?:[^"\\]|\\.)*"/, `(fp_text value ${q(inst.value)}`);
    } else if (s.tag === 'pad') {
      const pad = /^\(pad\s+"((?:[^"\\]|\\.)*)"/.exec(t)?.[1] ?? /^\(pad\s+([^\s()"]+)/.exec(t)?.[1] ?? '';
      const net = pad ? inst.padNet(pad) : undefined;
      if (net) {
        const close = t.lastIndexOf(')');
        t = `${t.slice(0, close).replace(/\s*$/, '')}\n\t\t(net ${net[0]} ${q(net[1])})\n\t)`;
      }
    }
    parts.push(t);
    if (s.tag === 'layer' && !placed) {
      parts.push(...placement);
      placed = true;
    }
  }
  if (!placed) parts.splice(1, 0, ...placement);
  parts.push(`(path ${q(inst.path)})`, `(sheetname ${q(inst.sheetname || '/')})`, `(sheetfile ${q(inst.sheetfile)})`);
  // library layout (children one tab in), then one more level as a board child
  const block = `${parts[0]}\n\t${parts.slice(1).join('\n\t')}\n)`;
  return block
    .split('\n')
    .map((l) => `\t${l}`)
    .join('\n');
}

// ---- the board --------------------------------------------------------------

/** Shelf-pack boxes into rows no wider than `width`; origins of each box. */
export function shelfPack(boxes: { w: number; h: number }[], width: number, gap: number): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const b of boxes) {
    if (x > 0 && x + b.w > width) {
      y += rowH + gap;
      x = 0;
      rowH = 0;
    }
    out.push({ x, y });
    x += b.w + gap;
    rowH = Math.max(rowH, b.h);
  }
  return out;
}

export interface PopulateResult {
  placed: { ref: string; footprint: string }[];
  nets: number;
  outline: { width: number; height: number; grown: boolean };
  /** True when the board already held exactly these footprints (no write). */
  unchanged: boolean;
}

export class PadMismatchError extends Error {
  constructor(readonly mismatches: PadMismatch[]) {
    super(
      `the schematic connects pins its footprints have no pad for, so those nets would vanish from the board:\n` +
        mismatches.map((m) => `  ${formatPadMismatch(m)}`).join('\n') +
        `\nFix the schematic (a symbol whose pin numbers match the footprint's pads, or the matching footprint in BOM.md and the intent), then re-run.`,
    );
  }
}

export class MissingFootprintsError extends Error {
  constructor(
    readonly missing: MissingFootprint[],
    readonly searched: string[],
  ) {
    super(`${missing.length} footprint(s) not installed: ${missing.map((m) => `${m.ref} ${m.footprint || '(none)'}`).join(', ')}`);
  }
}

/** (ref, footprint id) pairs of the footprints already on a board. */
export function boardFootprints(boardText: string): { ref: string; footprint: string }[] {
  const root = parseSexp(boardText)[0];
  if (!root || !isList(root)) return [];
  const out: { ref: string; footprint: string }[] = [];
  for (const fp of children(root, 'footprint')) {
    let ref = '';
    for (const p of children(fp, 'property')) if (atom(p, 1) === 'Reference') ref = atom(p, 2) ?? '';
    if (!ref) for (const t of children(fp, 'fp_text')) if (atom(t, 1) === 'reference') ref = atom(t, 2) ?? '';
    out.push({ ref, footprint: atom(fp, 1) ?? '' });
  }
  return out;
}

/** Do the board's (ref, footprint) pairs equal the netlist parts', exactly? */
export function boardMatchesNetlist(
  onBoard: { ref: string; footprint: string }[],
  parts: { ref: string; footprint: string }[],
): { ok: boolean; missing: string[]; extra: string[]; changed: string[] } {
  const want = new Map(parts.map((p) => [p.ref, p.footprint]));
  const have = new Map<string, string>();
  const extra: string[] = [];
  for (const f of onBoard) {
    if (!want.has(f.ref) || have.has(f.ref)) extra.push(f.ref || '(no ref)');
    else have.set(f.ref, f.footprint);
  }
  const missing = [...want.keys()].filter((r) => !have.has(r));
  const changed = [...have].filter(([r, fp]) => want.get(r) !== fp).map(([r, fp]) => `${r} (${fp}, schematic ${want.get(r)})`);
  return { ok: !missing.length && !extra.length && !changed.length, missing, extra, changed };
}

interface OutlineRect {
  start: number;
  end: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The board's outline when it is a single Edge.Cuts gr_rect (the scaffold's shape). */
function outlineRect(boardText: string, open: number): OutlineRect | null {
  const rects = childSpans(boardText, open).filter((s) => {
    if (s.tag !== 'gr_rect') return false;
    return /\(layer\s+"?Edge\.Cuts"?\)/.test(boardText.slice(s.start, s.end));
  });
  const edges = childSpans(boardText, open).filter(
    (s) => /^gr_(line|arc|circle|poly)$/.test(s.tag) && /\(layer\s+"?Edge\.Cuts"?\)/.test(boardText.slice(s.start, s.end)),
  );
  if (rects.length !== 1 || edges.length) return null;
  const t = boardText.slice(rects[0]!.start, rects[0]!.end);
  const s = /\(start\s+([-\d.]+)\s+([-\d.]+)\)/.exec(t);
  const e = /\(end\s+([-\d.]+)\s+([-\d.]+)\)/.exec(t);
  if (!s || !e) return null;
  const [a, b, c, d] = [s[1], s[2], e[1], e[2]].map(Number) as [number, number, number, number];
  return { start: rects[0]!.start, end: rects[0]!.end, x1: Math.min(a, c), y1: Math.min(b, d), x2: Math.max(a, c), y2: Math.max(b, d) };
}

const GAP = 1; // mm between courtyards
const MARGIN = 1; // mm from the outline

export interface PopulateOptions {
  repoRoot: string;
  schematic: string;
  board: string;
  resolver?: FootprintResolver;
  env?: NodeJS.ProcessEnv;
}

/**
 * Put every schematic part on the board with its exact footprint (AC-15.36).
 * All-or-nothing (AC-15.37): throws `MissingFootprintsError` or a load error
 * before writing anything, and leaves a board that already holds exactly the
 * schematic's footprints untouched.
 */
export async function populateBoard(opts: PopulateOptions): Promise<PopulateResult> {
  const schPath = path.join(opts.repoRoot, opts.schematic);
  const boardPath = path.join(opts.repoRoot, opts.board);
  const netlist = parseNetlist(await exportNetlist(schPath));
  const boardText = await readFile(boardPath, 'utf8');
  const onBoard = boardFootprints(boardText);
  if (onBoard.length) {
    const cmp = boardMatchesNetlist(onBoard, netlist.parts);
    if (cmp.ok) {
      return { placed: [], nets: netlist.nets.size, outline: { width: 0, height: 0, grown: false }, unchanged: true };
    }
    throw new Error(
      `${opts.board} already has footprints that do not match the schematic` +
        ` (missing: ${cmp.missing.join(', ') || 'none'}; extra: ${cmp.extra.join(', ') || 'none'}; changed: ${cmp.changed.join(', ') || 'none'});` +
        ' populate fills an empty board only',
    );
  }

  const resolver =
    opts.resolver ?? (await FootprintResolver.create({ projectDir: path.dirname(boardPath), ...(opts.env ? { env: opts.env } : {}) }));
  const missing = await missingFootprints(netlist.parts, resolver);
  if (missing.length) throw new MissingFootprintsError(missing, resolver.searched);

  // net codes: sorted by name, so the same schematic always numbers the same way
  const netNames = [...netlist.nets.keys()].sort((a, b) => a.localeCompare(b));
  const code = new Map(netNames.map((n, i) => [n, i + 1]));
  const netOf = new Map<string, [number, string]>();
  for (const [name, nodes] of netlist.nets) for (const [ref, pin] of nodes) netOf.set(`${ref}\0${pin}`, [code.get(name)!, name]);

  const mods = new Map<string, { text: string }>();
  for (const p of netlist.parts) {
    if (mods.has(p.footprint)) continue;
    const r = await resolver.resolve(p.footprint);
    if (!r.ok) throw new MissingFootprintsError([{ ref: p.ref, footprint: p.footprint, why: r.why, near: r.near }], resolver.searched);
    const text = await readFile(r.file, 'utf8');
    mods.set(p.footprint, { text });
  }
  // every netlist pin must land on a pad, or its net silently drops off the board
  const pinsOf = new Map<string, Set<string>>();
  for (const nodes of netlist.nets.values())
    for (const [ref, pin] of nodes) {
      if (!pinsOf.has(ref)) pinsOf.set(ref, new Set());
      pinsOf.get(ref)!.add(pin);
    }
  const mismatches: PadMismatch[] = [];
  for (const p of netlist.parts) {
    const pads = padNumbers(mods.get(p.footprint)!.text);
    const pins = [...(pinsOf.get(p.ref) ?? [])].filter((pin) => !pads.has(pin));
    if (pins.length) {
      const byNum = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true });
      mismatches.push({ ref: p.ref, footprint: p.footprint, pins: pins.sort(byNum), pads: [...pads].sort(byNum) });
    }
  }
  if (mismatches.length) throw new PadMismatchError(mismatches);

  const boundsOf = new Map(netlist.parts.map((p) => [p.ref, footprintBounds(mods.get(p.footprint)!.text, { ref: p.ref, value: p.value })]));

  // biggest first: the module anchors the pack; ties by refdes for stability
  const order = [...netlist.parts].sort((a, b) => {
    const area = (p: NetlistPart): number => {
      const bb = boundsOf.get(p.ref)!;
      return (bb.maxX - bb.minX) * (bb.maxY - bb.minY);
    };
    return area(b) - area(a) || a.ref.localeCompare(b.ref, undefined, { numeric: true });
  });
  const boxes = order.map((p) => {
    const bb = boundsOf.get(p.ref)!;
    return { w: bb.maxX - bb.minX, h: bb.maxY - bb.minY };
  });

  const open = boardText.indexOf('(kicad_pcb');
  if (open < 0) throw new Error(`${opts.board} is not a KiCad board`);
  const rect = outlineRect(boardText, open);
  const origin = rect ? { x: rect.x1 + MARGIN, y: rect.y1 + MARGIN } : { x: 100 + MARGIN, y: 100 + MARGIN };
  const totalArea = boxes.reduce((s, b) => s + (b.w + GAP) * (b.h + GAP), 0);
  const widest = Math.max(...boxes.map((b) => b.w));
  // rows as wide as the outline, or roughly square when the parts need more
  // room than it has, so a large design grows the board both ways
  const width = Math.max(widest, rect ? rect.x2 - rect.x1 - 2 * MARGIN : 0, Math.sqrt(totalArea));
  const origins = shelfPack(boxes, width, GAP);

  const blocks = order.map((p, i) => {
    const bb = boundsOf.get(p.ref)!;
    return instantiateFootprint(mods.get(p.footprint)!.text, {
      fpId: p.footprint,
      ref: p.ref,
      value: p.value,
      uuid: uuidv5(`board-footprint/${p.path || p.ref}`),
      // the footprint origin sits at -minX/-minY inside its box
      at: { x: origin.x + origins[i]!.x - bb.minX, y: origin.y + origins[i]!.y - bb.minY },
      path: p.path,
      sheetname: p.sheetname,
      sheetfile: p.sheetfile,
      padNet: (pad) => netOf.get(`${p.ref}\0${pad}`),
    });
  });
  const usedW = Math.max(...order.map((_, i) => origins[i]!.x + boxes[i]!.w));
  const usedH = Math.max(...order.map((_, i) => origins[i]!.y + boxes[i]!.h));

  // splice: net table after `(net 0 "")` (or before the first footprint-able
  // item), outline grown when the pack overflows it, footprints before the
  // board's closing paren
  let text = boardText;
  const edits: { at: number; del: number; ins: string }[] = [];
  let grown = false;
  let outline = { width: rect ? rect.x2 - rect.x1 : 0, height: rect ? rect.y2 - rect.y1 : 0 };
  if (rect) {
    const needW = usedW + 2 * MARGIN;
    const needH = usedH + 2 * MARGIN;
    if (needW > rect.x2 - rect.x1 || needH > rect.y2 - rect.y1) {
      const w = Math.ceil(Math.max(needW, rect.x2 - rect.x1));
      const h = Math.ceil(Math.max(needH, rect.y2 - rect.y1));
      const old = text.slice(rect.start, rect.end);
      const next = old
        .replace(/\(start\s+[-\d.]+\s+[-\d.]+\)/, `(start ${num(rect.x1)} ${num(rect.y1)})`)
        .replace(/\(end\s+[-\d.]+\s+[-\d.]+\)/, `(end ${num(rect.x1 + w)} ${num(rect.y1 + h)})`);
      edits.push({ at: rect.start, del: rect.end - rect.start, ins: next });
      outline = { width: w, height: h };
      grown = true;
    }
  }
  const netDecl = netNames.map((n) => `\t(net ${code.get(n)} ${q(n)})`).join('\n');
  const net0 = /\(net\s+0\s+""\)/.exec(text);
  if (net0) edits.push({ at: net0.index + net0[0].length, del: 0, ins: `\n${netDecl}` });
  else {
    const first = childSpans(text, open).find((s) => /^(gr_|footprint|segment|via|zone)/.test(s.tag));
    const at = first ? first.start : listEnd(text, open) - 1;
    edits.push({ at, del: 0, ins: `(net 0 "")\n${netDecl}\n\t` });
  }
  const close = listEnd(text, open) - 1;
  edits.push({ at: close, del: 0, ins: `${blocks.join('\n')}\n` });
  for (const e of edits.sort((a, b) => b.at - a.at)) text = text.slice(0, e.at) + e.ins + text.slice(e.at + e.del);

  // KiCad must load it before it replaces the board (AC-15.37)
  const dir = await mkdtemp(path.join(tmpdir(), 'copperhead-populate-'));
  try {
    const probe = path.join(dir, path.basename(boardPath));
    await writeFile(probe, text, 'utf8');
    const err = await kicadLoadError(probe);
    if (err) throw new Error(`the populated board does not load in KiCad, so ${opts.board} was left unchanged: ${err}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await writeFile(boardPath, text, 'utf8');
  return {
    placed: netlist.parts.map((p) => ({ ref: p.ref, footprint: p.footprint })),
    nets: netNames.length,
    outline: { ...outline, grown },
    unchanged: false,
  };
}

// ---- moving a placed footprint ----------------------------------------------

const normAngle = (a: number): number => {
  const r = Math.round((((a % 360) + 360) % 360) * 1e4) / 1e4;
  return r === 360 ? 0 : r;
};
const atText = (x: number, y: number, a: number): string => `(at ${num(x)} ${num(y)}${a ? ` ${num(a)}` : ''})`;

/**
 * Move (and optionally rotate) one placed footprint, found by refdes (#314).
 * A KiCad board stores every pad's and text's angle as ABSOLUTE, so turning a
 * footprint by editing only its own `(at X Y ROT)` leaves the pads facing the
 * old way: the part no longer matches its library and fine-pitch pads short
 * into each other. This rotates them together, by anchored splices only.
 */
export function moveFootprint(boardText: string, ref: string, x: number, y: number, rotation?: number): string {
  const open = boardText.indexOf('(kicad_pcb');
  if (open < 0) throw new Error('not a KiCad board');
  const owns = (s: Span): boolean => {
    const t = boardText.slice(s.start, s.end);
    return t.includes(`(property "Reference" ${q(ref)}`) || t.includes(`(fp_text reference ${q(ref)}`);
  };
  const fps = childSpans(boardText, open).filter((s) => s.tag === 'footprint' && owns(s));
  if (fps.length !== 1) throw new Error(fps.length ? `more than one footprint has refdes ${ref}` : `no footprint with refdes ${ref} on the board`);
  const fp = fps[0]!;
  const kids = childSpans(boardText, fp.start);
  const at = kids.find((k) => k.tag === 'at');
  if (!at) throw new Error(`${ref} has no (at …) placement`);
  const nums = boardText.slice(at.start, at.end).match(/-?[\d.]+/g)?.map(Number) ?? [];
  const from = normAngle(nums[2] ?? 0);
  const to = normAngle(rotation ?? from);
  const delta = to - from;
  const edits: { start: number; end: number; text: string }[] = [{ start: at.start, end: at.end, text: atText(x, y, to) }];
  if (delta) {
    for (const k of kids) {
      if (k.tag !== 'pad' && k.tag !== 'property' && k.tag !== 'fp_text') continue;
      const own = childSpans(boardText, k.start).find((c) => c.tag === 'at');
      if (!own) continue;
      const v = boardText.slice(own.start, own.end).match(/-?[\d.]+/g)?.map(Number) ?? [];
      const rest = / unlocked\)$/.test(boardText.slice(own.start, own.end)) ? ' unlocked' : '';
      edits.push({ start: own.start, end: own.end, text: atText(v[0] ?? 0, v[1] ?? 0, normAngle((v[2] ?? 0) + delta)).replace(/\)$/, `${rest})`) });
    }
  }
  let text = boardText;
  for (const e of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  return text;
}
