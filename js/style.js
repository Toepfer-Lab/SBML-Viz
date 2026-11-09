// Visual language shared by the 2D and 3D views (see the "Visual language" design board).

export const BG = '#0E1014';
export const ACCENT = '#5CC8E8';
export const TEXT = '#E7E9EE';
export const MUTED = '#A1A9B8';
export const REACTION = '#A1A9B8';
export const SIDE = '#5E6573';
export const SIDE_LABEL = '#8A919E';
export const LINK = '#3A4150';
export const PARTICLE = '#FFC890';
export const DIM = 0.3;
const FLUX_LO = [0x4A, 0x3A, 0x2C];
const FLUX_HI = [0xF2, 0x99, 0x4A];

export function fluxRGB(t) {
  return FLUX_LO.map((lo, i) => Math.round(lo + (FLUX_HI[i] - lo) * t));
}

export function fluxColor(t, alpha = 1) {
  const c = fluxRGB(t);
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

// Nodes/links lit by the current highlight (a path) or else the selection's focus.
export function litSet(s) {
  return s.highlight || (s.selected ? s.focus : null);
}

export function hexAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function endId(end) {
  return typeof end === 'object' ? end.id : end;
}

// Log scale over the |v| present in the drawn links -> t in [0, 1].
export function fluxScale(links) {
  const vs = links.map(l => l.v).filter(v => v > 0);
  const max = vs.length ? Math.max(...vs) : 1;
  const min = vs.length ? Math.max(Math.min(...vs), max * 1e-6) : 1;
  return v => {
    if (!v || v <= 0) return 0;
    if (max <= min) return 1;
    return Math.min(1, Math.max(0, Math.log10(v / min) / Math.log10(max / min)));
  };
}

export function nodeColor(n, styles) {
  if (n.kind === 'rxn') return REACTION;
  if (n.kind === 'side') return SIDE;
  return styles.get(n.compartment)?.color || '#C9CED8';
}

export function degrees(graph) {
  const degree = new Map();
  for (const l of graph.links) {
    degree.set(endId(l.source), (degree.get(endId(l.source)) || 0) + 1);
    degree.set(endId(l.target), (degree.get(endId(l.target)) || 0) + 1);
  }
  return degree;
}

// Selected node plus everything one link away.
export function focusSet(graph, selected) {
  const focus = new Set(selected ? [selected] : []);
  if (!selected) return focus;
  for (const l of graph.links) {
    const a = endId(l.source);
    const b = endId(l.target);
    if (a === selected) focus.add(b);
    if (b === selected) focus.add(a);
  }
  return focus;
}

// d3 force pulling each compartment's species toward its own anchor on a
// ring, so the layout reads as spatial clusters. `get()` returns
// { enabled, nodes, dims } at tick time.
export function clusterForce(get) {
  let nodes = [];
  let anchors = null;
  let anchorKey = '';
  const force = alpha => {
    const { enabled, dims } = get();
    if (!enabled) return;
    const comps = [...new Set(nodes.map(n => n.compartment).filter(Boolean))];
    const key = comps.join('|') + dims + nodes.length;
    if (key !== anchorKey) {
      const radius = 30 + 4 * Math.sqrt(nodes.length);
      anchors = new Map(comps.map((c, i) => {
        const a = (i / comps.length) * Math.PI * 2;
        return [c, { x: Math.cos(a) * radius, y: dims === 3 ? (i % 2 ? 0.25 : -0.25) * radius : Math.sin(a) * radius, z: Math.sin(a) * radius }];
      }));
      anchorKey = key;
    }
    const k = 0.04 * alpha;
    for (const n of nodes) {
      const a = n.compartment && anchors.get(n.compartment);
      if (!a) continue;
      n.vx += (a.x - n.x) * k;
      n.vy += (a.y - n.y) * k;
      if (dims === 3 && n.z !== undefined) n.vz += (a.z - n.z) * k;
    }
  };
  force.initialize = ns => { nodes = ns; };
  return force;
}

export function nodeTooltip(n, styles) {
  const comp = n.compartment ? (styles.get(n.compartment)?.label || n.compartment) : 'reaction';
  const name = n.name && n.name !== n.ref ? `<div style="opacity:.75">${escapeHtml(n.name)}</div>` : '';
  return `<div style="font:13px Inter,system-ui,sans-serif;padding:4px 2px"><div style="font-family:'JetBrains Mono',monospace">${escapeHtml(n.ref)}</div>${name}<div style="opacity:.75">${escapeHtml(comp)}</div></div>`;
}
