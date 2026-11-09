// 2D view: a flat, labelled reaction map drawn on canvas with force-graph
// (the "Explorer — model loaded" board). Same API as view.js.
import ForceGraph from 'force-graph';
import {
  BG, ACCENT, TEXT, LINK, SIDE, SIDE_LABEL, PARTICLE, DIM,
  fluxColor, hexAlpha, endId, nodeColor, degrees, focusSet, clusterForce, nodeTooltip, litSet,
} from './style.js';
import { createLayoutControl, placeFresh } from './layout.js';

const MONO = '"JetBrains Mono", ui-monospace, monospace';
const FAINT = 0.35;

export function createView2D(el, { onNodeClick, onFrozen, options }) {
  const s = {
    graph: { nodes: [], links: [] },
    styles: new Map(),
    selected: null,
    focus: new Set(),
    highlight: null,
    hubs: new Set(),
    fluxT: () => 0,
    ...options,
  };

  const Graph = new ForceGraph(el)
    .backgroundColor('rgba(0,0,0,0)') // the viewport's CSS gradient shows through
    .nodeId('id')
    .nodeLabel(n => nodeTooltip(n, s.styles))
    .nodeCanvasObjectMode(() => 'replace')
    .nodeCanvasObject(drawNode)
    .nodePointerAreaPaint(paintHitArea)
    .linkColor(linkColor)
    .linkWidth(linkWidth)
    .linkLineDash(l => (l.belowCut ? [3, 3] : null))
    .linkDirectionalParticles(linkParticles)
    .linkDirectionalParticleSpeed(l => 0.003 + 0.012 * s.fluxT(l.v))
    .linkDirectionalParticleWidth(l => 2.5 + 2 * s.fluxT(l.v))
    .linkDirectionalParticleColor(() => PARTICLE)
    .enableNodeDrag(s.drag)
    .onEngineStop(() => layout.engineStopped())
    .onNodeClick(handleClick);

  Graph.d3Force('cluster', clusterForce(() => ({ enabled: s.cluster, dims: 2 })));
  Graph.d3Force('charge').strength(n => (n.kind === 'side' ? -15 : -80));
  Graph.d3Force('link')
    .distance(l => (l.side ? 10 : 34))
    .strength(l => (l.side ? 1 : 0.5));
  const layout = createLayoutControl(Graph, { dims: 2, onFrozen });

  // --- drawing ----------------------------------------------------------------

  const isLit = id => {
    const lit = litSet(s);
    return !lit || lit.has(id);
  };

  function radius(n) {
    if (n.kind === 'side') return 3;
    if (n.kind === 'rxn') return 4;
    return n.id === s.selected ? 6 : 4 + Math.min(3, Math.sqrt(n.degree || 1) * 0.5);
  }

  function wantsLabel(n) {
    const lit = litSet(s);
    if (lit && lit.has(n.id)) return true;
    if (n.kind === 'side') return s.labels === 'all' && !lit;
    if (s.labels === 'all') return true;
    return s.labels === 'hubs' && s.hubs.has(n.id);
  }

  function drawNode(n, ctx, k) {
    const color = nodeColor(n, s.styles);
    const r = radius(n);
    ctx.save();
    ctx.globalAlpha = (isLit(n.id) ? 1 : DIM) * (n.belowCut ? FAINT : 1);

    if (n.kind === 'rxn') {
      if (n.reversible) {
        ctx.fillStyle = BG;
        ctx.fillRect(n.x - r, n.y - r, 2 * r, 2 * r);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(n.x - r, n.y - r, 2 * r, 2 * r);
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(n.x - r, n.y - r, 2 * r, 2 * r);
      }
      if (n.flipped) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 9, 0, 2 * Math.PI);
        ctx.setLineDash([2, 2]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else {
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
    }

    if (n.id === s.selected) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = ACCENT;
      if (n.kind === 'rxn') ctx.strokeRect(n.x - r - 1.5, n.y - r - 1.5, 2 * r + 3, 2 * r + 3);
      else ctx.stroke();
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 6, 0, 2 * Math.PI);
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (wantsLabel(n)) {
      // Fixed on-screen size regardless of zoom, hidden when zoomed far out.
      const px = n.id === s.selected ? 13 : n.kind === 'side' ? 9 : 11;
      if (px * k >= 6 || n.id === s.selected) {
        const size = px / Math.max(k, 0.4);
        ctx.font = `${n.id === s.selected ? 500 : 400} ${size}px ${MONO}`;
        ctx.textBaseline = 'middle';
        ctx.fillStyle = n.id === s.selected ? TEXT : n.kind === 'side' ? SIDE_LABEL : '#C9CED8';
        const dy = n.id === s.selected ? r + 4 + size / 2 : 0;
        ctx.fillText(n.label, n.x + (dy ? -r : r + 3), n.y + dy);
      }
    }
    ctx.restore();
  }

  function paintHitArea(n, color, ctx) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(n.x, n.y, Math.max(radius(n), 4) + 3, 0, 2 * Math.PI);
    ctx.fill();
  }

  function emphasised(l) {
    const a = endId(l.source);
    const b = endId(l.target);
    if (s.highlight) return s.highlight.has(a) && s.highlight.has(b);
    return !!s.selected && (a === s.selected || b === s.selected);
  }

  function linkColor(l) {
    const lit = isLit(endId(l.source)) && isLit(endId(l.target));
    const alpha = (lit ? 0.6 : 0.6 * DIM) * (l.belowCut ? FAINT * 1.5 : 1);
    if (l.side) return hexAlpha(SIDE, alpha);
    if (!l.v) return hexAlpha(LINK, alpha);
    return fluxColor(s.fluxT(l.v), emphasised(l) ? 0.8 : alpha);
  }

  function linkWidth(l) {
    if (!l.v || l.side) return 1;
    return (emphasised(l) ? 1.5 : 1) + 2.5 * s.fluxT(l.v);
  }

  function linkParticles(l) {
    if (s.particles === 'off' || !l.v || l.belowCut) return 0;
    if (emphasised(l)) return 3;
    return s.particles === 'visible' && s.fluxT(l.v) > 0.15 ? 1 : 0;
  }

  function restyle() {
    Graph
      .nodeCanvasObject(drawNode)
      .linkColor(linkColor)
      .linkWidth(linkWidth)
      .linkDirectionalParticles(linkParticles);
  }

  // --- interaction -------------------------------------------------------------

  let lastClick = { id: null, t: 0 };
  function handleClick(n) {
    const now = performance.now();
    if (lastClick.id === n.id && now - lastClick.t < 400) flyTo(n.id);
    lastClick = { id: n.id, t: now };
    onNodeClick(n);
  }

  function flyTo(id, ms = 800) {
    const n = s.graph.nodes.find(x => x.id === id);
    if (!n || n.x === undefined) return;
    Graph.centerAt(n.x, n.y, ms);
    if (Graph.zoom() < 2.5) Graph.zoom(2.5, ms);
  }

  const resize = new ResizeObserver(() => Graph.width(el.clientWidth).height(el.clientHeight));
  resize.observe(el);

  return {
    dims: 2,
    get live() { return layout.live; },
    qualityText: () => '',
    setData(graph, { styles, live, fluxT }) {
      const old = new Map(s.graph.nodes.map(n => [n.id, n]));
      const degree = degrees(graph);
      for (const n of graph.nodes) {
        n.degree = degree.get(n.id) || 0;
        delete n.z;
        const prev = old.get(n.id);
        if (prev && n.x === undefined) Object.assign(n, { x: prev.x, y: prev.y });
      }
      const fresh = placeFresh(graph, 2);
      const byId = new Map(graph.nodes.map(n => [n.id, n]));
      for (const l of graph.links) {
        l.source = byId.get(endId(l.source));
        l.target = byId.get(endId(l.target));
      }
      s.fluxT = fluxT;
      s.hubs = new Set(graph.nodes.filter(n => n.kind === 'met').sort((a, b) => b.degree - a.degree).slice(0, 30).map(n => n.id));
      s.graph = graph;
      s.styles = styles;
      s.selected = byId.has(s.selected) ? s.selected : null;
      s.focus = focusSet(graph, s.selected);
      Graph.graphData(graph);
      layout.afterData(fresh, live || fresh.length === graph.nodes.length);
    },
    setSelection(id) {
      s.selected = id && s.graph.nodes.some(n => n.id === id) ? id : null;
      s.focus = focusSet(s.graph, s.selected);
      restyle();
    },
    setHighlight(ids) {
      s.highlight = ids ? new Set(ids) : null;
      restyle();
    },
    setLive(on) { layout.setLive(on); },
    set(key, value) {
      s[key] = value;
      if (key === 'cluster') { if (layout.live) Graph.d3ReheatSimulation(); }
      else if (key === 'drag') Graph.enableNodeDrag(value);
      else if (key === 'grid' || key === 'rotate' || key === 'quality') { /* 3D only */ }
      else restyle();
    },
    zoom(factor) { Graph.zoom(Graph.zoom() / factor, 300); },
    fit() {
      // zoomToFit on one or two nodes zooms in without limit; cap it.
      Graph.zoomToFit(600, 60);
      setTimeout(() => { if (Graph.zoom() > 4) Graph.zoom(4, 300); }, 650);
    },
    flyTo,
    positions() {
      const out = {};
      for (const n of s.graph.nodes) {
        if (n.x !== undefined) out[n.id] = [n.x, n.y, 0];
      }
      return out;
    },
    screenshot() {
      // The canvas is transparent; flatten it onto the ground color.
      const src = el.querySelector('canvas');
      const out = document.createElement('canvas');
      out.width = src.width;
      out.height = src.height;
      const ctx = out.getContext('2d');
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(src, 0, 0);
      return out.toDataURL('image/png');
    },
    destroy() {
      resize.disconnect();
      Graph._destructor();
      el.replaceChildren();
    },
  };
}
