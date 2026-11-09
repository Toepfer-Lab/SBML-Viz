// Lays out a graph off the main thread with the views' forces, so a model is
// drawn only once the simulation has run out of energy. One job at a time; a
// new message replaces it.
//   in:  { job, dims, cluster, nodes, links }
//          nodes: [{ id, kind, compartment, x?, y?, z? }]; a node with a
//          position stays where it is, the others are laid out around it
//          links: [{ source, target, side }]
//        { job, stop: true }  ends that job now with the positions it has
//   out: { job, type: 'progress', fraction }  then
//        { job, type: 'done', positions: { id: [x, y, z] }, ticks, ms }
import { forceSimulation, forceLink, forceManyBody, forceCenter } from 'https://cdn.jsdelivr.net/npm/d3-force-3d@3.0.6/+esm';
import { ALPHA_MIN, FORCES } from './layout.js';
import { clusterForce } from './style.js';

const MAX_MS = 600000; // only guards against a layout that never ends

let current = null;

self.onmessage = ({ data }) => {
  if (data.stop) {
    if (current?.job === data.job) current.stopped = true;
    return;
  }
  run(data);
};

function run({ job, dims, cluster, nodes, links }) {
  for (const n of nodes) {
    if (n.x === undefined) continue;
    n.fx = n.x;
    n.fy = n.y;
    if (dims === 3) n.fz = n.z;
  }
  const f = FORCES[dims];
  const link = forceLink(links).id(n => n.id).distance(f.distance);
  if (f.strength) link.strength(f.strength);
  const sim = forceSimulation(nodes, dims)
    .alphaMin(ALPHA_MIN)
    .force('link', link)
    .force('charge', forceManyBody().strength(f.charge))
    .force('center', forceCenter())
    .force('cluster', clusterForce(() => ({ enabled: cluster, dims })))
    .stop();
  const state = { job, stopped: false };
  current = state;
  const start = performance.now();
  let ticks = 0;

  // Tick in slices so progress gets out and a stop or a newer job gets in.
  const slice = () => {
    if (current !== state) return;
    const until = performance.now() + 50;
    while (!state.stopped && sim.alpha() >= ALPHA_MIN && performance.now() < until) {
      sim.tick();
      ticks++;
    }
    if (!state.stopped && sim.alpha() >= ALPHA_MIN && performance.now() - start < MAX_MS) {
      // alpha decays geometrically from 1 to ALPHA_MIN, so progress is measured in logs.
      self.postMessage({ job, type: 'progress', fraction: Math.min(0.99, Math.log(sim.alpha()) / Math.log(ALPHA_MIN)) });
      setTimeout(slice, 0);
      return;
    }
    current = null;
    const positions = {};
    for (const n of nodes) positions[n.id] = [n.x, n.y, dims === 3 ? n.z : 0];
    self.postMessage({ job, type: 'done', positions, ticks, ms: Math.round(performance.now() - start) });
  };
  slice();
}
