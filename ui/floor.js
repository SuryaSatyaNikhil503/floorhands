const CELL_W = 170, CELL_H = 130, HEAD = 48, PAD = 24, GAP = 28, COLS = 2;
const UNASSIGNED = '__unassigned__';

export const initials = name => String(name ?? '').split(/\s+/).filter(Boolean).map(w => Array.from(w)[0]).join('').slice(0, 2).toUpperCase();

// Pods sit side by side, or (stack: true, for phones) one under another.
// Agents whose pod is missing from the roster go to an UNASSIGNED pod rather than disappearing.
export function layoutFloor(roster, { stack = false } = {}) {
  const podDefs = [];
  for (const p of Array.isArray(roster?.pods) ? roster.pods : []) {
    if (!podDefs.some(d => d.id === String(p.id))) podDefs.push({ id: String(p.id), name: p.name });
  }
  const agents = Array.isArray(roster?.agents) ? roster.agents : [];
  const known = new Set(podDefs.map(p => p.id));
  const members = new Map(podDefs.map(p => [p.id, []]));
  const strays = [];
  for (const a of agents) {
    const list = members.get(String(a.pod));
    if (list) list.push(a); else strays.push(a);
  }
  if (strays.length) { podDefs.push({ id: known.has(UNASSIGNED) ? `${UNASSIGNED}x` : UNASSIGNED, name: 'UNASSIGNED' }); members.set(podDefs.at(-1).id, strays); }

  let x = GAP, y = GAP;
  let tallest = 0;
  const pods = podDefs.map(p => {
    const list = members.get(p.id).sort((a, b) => (b.lead ? 1 : 0) - (a.lead ? 1 : 0));
    const rows = Math.max(1, Math.ceil(list.length / COLS));
    const w = COLS * CELL_W + PAD * 2;
    const h = HEAD + rows * CELL_H + PAD;
    const desks = list.map((a, i) => ({
      agentId: a.id,
      x: x + PAD + (i % COLS) * CELL_W + CELL_W / 2,
      y: y + HEAD + Math.floor(i / COLS) * CELL_H + CELL_H / 2,
    }));
    const pod = { id: p.id, name: p.name, x, y, w, h, desks };
    if (stack) y += h + GAP; else x += w + GAP;
    tallest = Math.max(tallest, h);
    return pod;
  });
  if (stack) return { width: GAP * 2 + COLS * CELL_W + PAD * 2, height: pods.length ? y : GAP * 2, pods };
  return { width: x, height: GAP * 2 + tallest, pods };
}
