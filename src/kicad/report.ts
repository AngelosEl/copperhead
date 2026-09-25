export interface ViolationItem {
  description: string;
  x?: number;
  y?: number;
}

export interface Violation {
  severity: 'error' | 'warning' | string;
  type: string;
  description: string;
  sheet?: string;
  items: ViolationItem[];
}

export interface CheckReport {
  ok: boolean;
  source: 'erc' | 'drc';
  violations: Violation[];
  /**
   * DRC only: connections not yet routed (KiCad's `unconnected_items`). A
   * draft board legitimately leaves nets as ratsnest (SPEC §First-draft
   * layout), so they are counted and reported, never a violation (#314).
   */
  unrouted?: number;
  /**
   * DRC only: findings whose every item belongs to one footprint (a stock
   * USB-C footprint's pad 0.18 mm from its own peg hole). Placement cannot
   * move them and layout may not edit footprints, so they are reported
   * beside the result, never a failure (#314). Anything spanning two parts,
   * or copper outside a footprint, stays a violation.
   */
  intrinsic?: Violation[];
}

interface RawItem {
  description?: string;
  pos?: { x?: number; y?: number };
}

interface RawViolation {
  severity?: string;
  type?: string;
  description?: string;
  items?: RawItem[];
}

function normViolation(v: RawViolation, sheet?: string): Violation {
  return {
    severity: v.severity ?? 'error',
    type: v.type ?? 'unknown',
    description: v.description ?? '',
    ...(sheet !== undefined ? { sheet } : {}),
    items: (v.items ?? []).map((i) => ({
      description: i.description ?? '',
      ...(i.pos?.x !== undefined ? { x: i.pos.x } : {}),
      ...(i.pos?.y !== undefined ? { y: i.pos.y } : {}),
    })),
  };
}

/**
 * Normalize kicad-cli ERC and DRC JSON reports into one shape. ERC nests
 * violations per sheet; DRC has top-level `violations` plus `unconnected_items`
 * and `schematic_parity`. Unrouted connections are a count, not violations:
 * `ok` means nothing routed or placed is wrong. Tolerant of missing fields
 * across KiCad versions.
 */
export function normalizeReport(raw: unknown, source: 'erc' | 'drc'): CheckReport {
  const r = raw as {
    sheets?: { path?: string; violations?: RawViolation[] }[];
    violations?: RawViolation[];
    unconnected_items?: RawViolation[];
    schematic_parity?: RawViolation[];
  };
  const violations: Violation[] = [];
  for (const sheet of r.sheets ?? []) {
    for (const v of sheet.violations ?? []) violations.push(normViolation(v, sheet.path));
  }
  // a footprint that no longer matches its library was edited on the board,
  // so what lies inside it is not the library's doing and is not excused
  const modified = new Set(
    (r.violations ?? [])
      .filter((v) => v.type === 'lib_footprint_mismatch')
      .flatMap((v) => (v.items ?? []).map((i) => /^Footprint (\S+)/.exec(i.description ?? '')?.[1]))
      .filter((x): x is string => !!x),
  );
  const intrinsic: Violation[] = [];
  for (const v of r.violations ?? []) {
    const n = normViolation(v);
    const owner = source === 'drc' ? footprintOwner(n) : null;
    if (owner && !modified.has(owner)) intrinsic.push(n);
    else violations.push(n);
  }
  for (const v of r.schematic_parity ?? []) violations.push(normViolation(v));
  const unrouted = r.unconnected_items?.length ?? 0;
  return { ok: violations.length === 0, source, violations, ...(source === 'drc' ? { unrouted, intrinsic } : {}) };
}

/**
 * The one footprint every item of a finding belongs to, or null. KiCad names
 * a footprint's items "Pad A1 [GND] of J1 on F.Cu", "NPTH pad of J1"; a track,
 * zone, or board-edge item names none, so it never counts as intrinsic.
 */
export function footprintOwner(v: Violation): string | null {
  if (!v.items.length) return null;
  let owner: string | null = null;
  for (const i of v.items) {
    const m = /\bof ([A-Za-z#_][\w#.-]*)\b/.exec(i.description);
    if (!m || (owner !== null && m[1] !== owner)) return null;
    owner = m[1]!;
  }
  return owner;
}

export function formatViolations(report: CheckReport): string {
  const unrouted = report.unrouted ? ` (${report.unrouted} connection(s) unrouted, left as ratsnest)` : '';
  const intrinsic = report.intrinsic?.length
    ? `\n  ${report.intrinsic.length} finding(s) inside a single library footprint, not a placement problem: ` +
      report.intrinsic.map((v) => `${footprintOwner(v)} ${v.type}`).join(', ')
    : '';
  if (report.ok) return `${report.source.toUpperCase()}: clean${unrouted}${intrinsic}`;
  const lines = [`${report.source.toUpperCase()}: ${report.violations.length} violation(s)${unrouted}${intrinsic}`];
  for (const v of report.violations) {
    const where = v.sheet ? ` [sheet ${v.sheet}]` : '';
    lines.push(`  ${v.severity} ${v.type}${where}: ${v.description}`);
    for (const i of v.items) {
      const pos = i.x !== undefined ? ` @ (${i.x}, ${i.y})` : '';
      lines.push(`    - ${i.description}${pos}`);
    }
  }
  return lines.join('\n');
}
