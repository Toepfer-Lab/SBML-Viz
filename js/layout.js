// Live / frozen layout shared by the 2D and 3D views.
//
// Live: forces run until the simulation settles, then the layout freezes.
// Frozen: every node is pinned (fx/fy/fz) and the forces are removed, so a
// drag moves only the dragged node and it stays where it is dropped. Nodes
// that appear later (scope or filter changes) settle around the pinned ones.
import { endId } from './style.js';

const FORCES = ['charge', 'link', 'center', 'cluster'];

export function createLayoutControl(Graph, { dims, onFrozen }) {
  const coords = dims === 3 ? ['x', 'y', 'z'] : ['x', 'y'];
  let saved = null;
  let live = true;
  let settlingFresh = false;

  const nodes = () => Graph.graphData().nodes;
  const pin = n => { for (const c of coords) n['f' + c] = n[c]; };
  const unpin = n => { for (const c of coords) delete n['f' + c]; };

  function forcesOff() {
    if (saved) return;
    saved = FORCES.map(k => [k, Graph.d3Force(k)]).filter(([, f]) => f);
    for (const [k] of saved) Graph.d3Force(k, null);
  }

  function forcesOn() {
    if (!saved) return;
    for (const [k, f] of saved) {
      // The link force kept the links of whatever graph it last saw.
      if (k === 'link') f.links(Graph.graphData().links);
      Graph.d3Force(k, f);
    }
    saved = null;
  }

  function freeze() {
    live = false;
    settlingFresh = false;
    nodes().forEach(pin);
    forcesOff();
    Graph.cooldownTime(600);
  }

  return {
    get live() { return live; },
    setLive(on) {
      if (on === live) return;
      if (!on) {
        freeze();
        return;
      }
      live = true;
      nodes().forEach(unpin);
      forcesOn();
      Graph.cooldownTime(15000);
      Graph.d3ReheatSimulation();
    },
    // Call right after graphData(). `fresh` = nodes that had no position.
    afterData(fresh, startLive) {
      if (startLive) {
        live = true;
        nodes().forEach(unpin);
        forcesOn();
        Graph.cooldownTime(15000);
        return;
      }
      live = false;
      const freshSet = new Set(fresh);
      for (const n of nodes()) {
        if (freshSet.has(n)) unpin(n);
        else pin(n);
      }
      if (fresh.length) {
        settlingFresh = true;
        forcesOn();
        Graph.cooldownTime(4000);
      } else {
        forcesOff();
        Graph.cooldownTime(600);
      }
    },
    engineStopped() {
      if (live) {
        freeze();
        onFrozen?.('settled');
      } else if (settlingFresh) {
        freeze();
        onFrozen?.('placed');
      } else {
        onFrozen?.('moved');
      }
    },
  };
}

// Put nodes without a position next to a positioned neighbour, so they start
// close to where they belong instead of at the origin.
export function placeFresh(graph, dims) {
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const fresh = graph.nodes.filter(n => n.x === undefined || Number.isNaN(n.x));
  if (!fresh.length) return fresh;
  const anyPlaced = graph.nodes.length > fresh.length;
  if (!anyPlaced) return fresh;
  const neighbours = new Map();
  for (const l of graph.links) {
    const a = endId(l.source);
    const b = endId(l.target);
    (neighbours.get(a) || neighbours.set(a, []).get(a)).push(b);
    (neighbours.get(b) || neighbours.set(b, []).get(b)).push(a);
  }
  const jitter = () => (Math.random() - 0.5) * 20;
  // Repeat so chains of new nodes grow outward from placed ones.
  for (let pass = 0; pass < 4; pass++) {
    for (const n of fresh) {
      if (n.x !== undefined && !Number.isNaN(n.x)) continue;
      const anchor = (neighbours.get(n.id) || []).map(id => byId.get(id)).find(m => m && m.x !== undefined && !Number.isNaN(m.x));
      if (!anchor) continue;
      n.x = anchor.x + jitter();
      n.y = anchor.y + jitter();
      if (dims === 3) n.z = (anchor.z || 0) + jitter();
    }
  }
  for (const n of fresh) {
    if (n.x === undefined || Number.isNaN(n.x)) {
      n.x = jitter() * 5;
      n.y = jitter() * 5;
      if (dims === 3) n.z = jitter() * 5;
    }
    if (dims === 3 && (n.z === undefined || Number.isNaN(n.z))) n.z = jitter();
  }
  return fresh;
}
