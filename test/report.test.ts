import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeReport, formatViolations } from '../src/kicad/report.js';
import { REPORTS } from './helpers.js';

const load = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(path.join(REPORTS, name), 'utf8'));

describe('report normalizer', () => {
  it('normalizes a clean ERC report', async () => {
    const r = normalizeReport(await load('erc-clean.json'), 'erc');
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('normalizes a clean DRC report', async () => {
    const r = normalizeReport(await load('drc-clean.json'), 'drc');
    expect(r.ok).toBe(true);
  });

  it('carries type, severity, and location for violations (AC-2.2 source)', async () => {
    const r = normalizeReport(await load('erc-unconnected-pin.json'), 'erc');
    expect(r.ok).toBe(false);
    const pin = r.violations.find((v) => v.type === 'pin_not_connected');
    expect(pin).toBeDefined();
    expect(pin!.severity).toBe('error');
    expect(pin!.sheet).toBe('/');
    expect(pin!.items[0]!.x).toBeTypeOf('number');
  });

  it('tolerates unknown shapes', () => {
    expect(normalizeReport({}, 'erc').ok).toBe(true);
    expect(normalizeReport({ violations: [{}] }, 'drc').violations).toHaveLength(1);
  });
});

describe('unrouted connections (#314)', () => {
  it('are counted, not violations: a draft board with ratsnest is DRC clean', () => {
    const r = normalizeReport(
      {
        violations: [],
        schematic_parity: [],
        unconnected_items: [
          { type: 'unconnected_items', severity: 'error', description: 'Missing connection', items: [] },
          { type: 'unconnected_items', severity: 'error', description: 'Missing connection', items: [] },
        ],
      },
      'drc',
    );
    expect(r.ok).toBe(true);
    expect(r.unrouted).toBe(2);
    expect(r.violations).toEqual([]);
    expect(formatViolations(r)).toBe('DRC: clean (2 connection(s) unrouted, left as ratsnest)');
  });

  it('a real violation still fails beside unrouted ones', () => {
    const r = normalizeReport(
      {
        violations: [{ type: 'clearance', severity: 'error', description: 'Clearance violation', items: [] }],
        unconnected_items: [{ type: 'unconnected_items', severity: 'error', description: 'Missing connection', items: [] }],
      },
      'drc',
    );
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.type)).toEqual(['clearance']);
    expect(r.unrouted).toBe(1);
  });
});

describe('findings inside one library footprint (#314)', () => {
  const v = (type: string, ...items: string[]) => ({ type, severity: 'error', description: type, items: items.map((description) => ({ description })) });

  it('are reported, not violations, when every item belongs to the same footprint', () => {
    const r = normalizeReport({ violations: [v('hole_clearance', 'Pad A1 [GND] of J1 on F.Cu', 'NPTH pad of J1')] }, 'drc');
    expect(r.ok).toBe(true);
    expect(r.intrinsic?.map((x) => x.type)).toEqual(['hole_clearance']);
    expect(formatViolations(r)).toContain('1 finding(s) inside a single library footprint, not a placement problem: J1 hole_clearance');
  });

  it('still fail when they span two parts or involve copper outside a footprint', () => {
    const between = normalizeReport({ violations: [v('clearance', 'Pad 1 [VBUS] of J1 on F.Cu', 'Pad 2 [GND] of R1 on F.Cu')] }, 'drc');
    expect(between.ok).toBe(false);
    const track = normalizeReport({ violations: [v('clearance', 'Pad 1 [VBUS] of J1 on F.Cu', 'Track [GND] on F.Cu, length 2.1 mm')] }, 'drc');
    expect(track.ok).toBe(false);
    expect(track.intrinsic).toEqual([]);
  });
});
