// 3D view: 3d-force-graph runs the layout and picking, but nodes and links are
// drawn in a few batched objects (instanced meshes, merged line segments)
// instead of one three.js object each. 3d-force-graph itself only draws the
// handful of emphasised links that need width or flow particles.
import * as THREE from 'three';
import ForceGraph3D from '3d-force-graph';
import {
  BG, ACCENT, TEXT, MUTED, LINK, PARTICLE,
  fluxRGB, endId, fluxScale, nodeColor, degrees, focusSet, clusterForce, nodeTooltip, litSet,
} from './style.js';
import { createLayoutControl, placeFresh } from './layout.js';

const GEO_HIGH = new THREE.SphereGeometry(1, 16, 12);
const GEO_FAST = new THREE.IcosahedronGeometry(1, 1);
const GEO_BOX = new THREE.BoxGeometry(1, 1, 1);
const GEO_RING = new THREE.SphereGeometry(1, 10, 6);
// Picking proxy: raycast against it, never drawn.
const GEO_HIT = new THREE.IcosahedronGeometry(1, 0);
const MAT_HIT = new THREE.MeshBasicMaterial({ visible: false });
// Unit cube edges as 12 segments (24 points) for reversible reactions.
const BOX_EDGES = new THREE.EdgesGeometry(GEO_BOX).attributes.position.array;

const BG_COLOR = new THREE.Color(BG);
const AUTO_FAST_NODES = 4000;
const LABEL_LIMIT = 1500;

const labelTextures = new Map();
function labelSprite(text, color, size) {
  const key = text + color;
  if (!labelTextures.has(key)) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const font = '500 40px "JetBrains Mono", monospace';
    ctx.font = font;
    canvas.width = Math.ceil(ctx.measureText(text).width) + 16;
    canvas.height = 56;
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 8, 28);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    labelTextures.set(key, { tex, aspect: canvas.width / canvas.height });
  }
  const { tex, aspect } = labelTextures.get(key);
  // Constant on-screen size: `size` is a fraction of the viewport height.
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: false }));
  sprite.scale.set(size * aspect, size, 1);
  sprite.center.set(0, 0.5);
  return sprite;
}

export function createView3D(el, { onNodeClick, onFrozen, options }) {
  const s = {
    graph: { nodes: [], links: [] },
    styles: new Map(),
    selected: null,
    focus: new Set(),
    highlight: null,
    hubs: new Set(),
    fluxT: () => 0,
    quality: 'auto',
    ...options,
  };
  let effective = 'high';
  let lowFpsSeconds = 0;
  let dirty = true;

  const Graph = new ForceGraph3D(el, { controlType: 'orbit' })
    .backgroundColor(BG)
    .showNavInfo(false)
    .nodeId('id')
    .nodeLabel(n => nodeTooltip(n, s.styles))
    .nodeThreeObject(n => {
      const m = new THREE.Mesh(GEO_HIT, MAT_HIT);
      m.scale.setScalar(Math.max(nodeSize(n), 2.5));
      return m;
    })
    .linkVisibility(emphasisedLink)
    .linkColor(l => {
      const [r, g, b] = fluxRGB(s.fluxT(l.v));
      return `rgb(${r},${g},${b})`;
    })
    .linkWidth(l => 0.6 + 2.4 * s.fluxT(l.v))
    .linkOpacity(0.9)
    .linkDirectionalParticles(linkParticles)
    .linkDirectionalParticleSpeed(l => 0.002 + 0.01 * s.fluxT(l.v))
    .linkDirectionalParticleWidth(2.2)
    .linkDirectionalParticleColor(() => PARTICLE)
    .enableNodeDrag(s.drag)
    .onEngineTick(() => { dirty = true; })
    .onEngineStop(() => {
      dirty = true;
      updateGrid();
      layout.engineStopped();
    })
    .onNodeDrag(() => { dirty = true; })
    .onNodeClick(handleClick);

  Graph.d3Force('cluster', clusterForce(() => ({ enabled: s.cluster, dims: 3 })));
  Graph.d3Force('charge').strength(-40);
  Graph.d3Force('link').distance(l => (l.side ? 6 : 18));
  const layout = createLayoutControl(Graph, { dims: 3, onFrozen });

  const scene = Graph.scene();
  const grid = new THREE.GridHelper(1, 20, 0x262B35, 0x1A1E26);
  grid.visible = false;
  scene.add(grid);

  // --- batched drawing ------------------------------------------------------------

  const layer = new THREE.Group();
  const overlay = new THREE.Group();
  scene.add(layer, overlay);
  let batches = null;

  function nodeSize(n) {
    if (n.kind === 'rxn') return 4;
    if (n.kind === 'side') return 1.4;
    return 3 + Math.min(3, Math.sqrt(n.degree || 1) * 0.4);
  }

  function lines(count, verticesPer) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(1, count) * verticesPer * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(Math.max(1, count) * verticesPer * 3), 3));
    geo.setDrawRange(0, count * verticesPer);
    const obj = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
    obj.frustumCulled = false;
    return obj;
  }

  function instanced(geo, material, list) {
    const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, list.length));
    mesh.count = list.length;
    mesh.frustumCulled = false;
    return mesh;
  }

  function disposeBatches() {
    if (!batches) return;
    for (const obj of layer.children) {
      obj.geometry !== GEO_HIGH && obj.geometry !== GEO_FAST && obj.geometry !== GEO_BOX && obj.geometry !== GEO_RING && obj.geometry.dispose();
      obj.material.dispose();
    }
    layer.clear();
    batches = null;
  }

  function buildBatches() {
    disposeBatches();
    const nodes = s.graph.nodes;
    const b = {
      sphereNodes: nodes.filter(n => n.kind !== 'rxn'),
      boxNodes: nodes.filter(n => n.kind === 'rxn' && !n.reversible),
      revNodes: nodes.filter(n => n.kind === 'rxn' && n.reversible),
      ringNodes: nodes.filter(n => n.kind === 'rxn' && n.flipped),
    };
    b.spheres = instanced(effective === 'fast' ? GEO_FAST : GEO_HIGH, new THREE.MeshLambertMaterial(), b.sphereNodes);
    b.boxes = instanced(GEO_BOX, new THREE.MeshLambertMaterial(), b.boxNodes);
    b.rings = instanced(GEO_RING, new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.35 }), b.ringNodes);
    b.rev = lines(b.revNodes.length, 24);
    b.links = lines(s.graph.links.length, 2);
    b.links.material.transparent = true;
    b.links.material.opacity = 0.85;
    layer.add(b.links, b.spheres, b.boxes, b.rings, b.rev);
    batches = b;
    paint();
    dirty = true;
  }

  // Colours: dimming blends toward the background instead of using
  // transparency, so everything stays in opaque, sortable batches.
  function nodeRGB(n, c, lit) {
    c.set(nodeColor(n, s.styles));
    if (n.belowCut) c.lerp(BG_COLOR, 0.55);
    if (!lit) c.lerp(BG_COLOR, 0.72);
    return c;
  }

  function linkRGB(l, c, lit) {
    if (l.v === null || l.v === 0) c.set(l.side ? '#2A2F38' : LINK);
    else {
      const [r, g, bl] = fluxRGB(s.fluxT(l.v));
      c.setRGB(r / 255, g / 255, bl / 255, THREE.SRGBColorSpace);
    }
    if (l.belowCut) c.lerp(BG_COLOR, 0.55);
    if (!lit) c.lerp(BG_COLOR, 0.72);
    return c;
  }

  function paint() {
    if (!batches) return;
    const lit = litSet(s);
    const isLit = id => !lit || lit.has(id);
    const c = new THREE.Color();
    for (const [mesh, list] of [[batches.spheres, batches.sphereNodes], [batches.boxes, batches.boxNodes], [batches.rings, batches.ringNodes]]) {
      list.forEach((n, i) => mesh.setColorAt(i, nodeRGB(n, c, isLit(n.id))));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    const revColors = batches.rev.geometry.attributes.color.array;
    batches.revNodes.forEach((n, i) => {
      nodeRGB(n, c, isLit(n.id));
      for (let v = 0; v < 24; v++) c.toArray(revColors, (i * 24 + v) * 3);
    });
    batches.rev.geometry.attributes.color.needsUpdate = true;
    const linkColors = batches.links.geometry.attributes.color.array;
    s.graph.links.forEach((l, i) => {
      linkRGB(l, c, isLit(endId(l.source)) && isLit(endId(l.target)));
      c.toArray(linkColors, i * 6);
      c.toArray(linkColors, i * 6 + 3);
    });
    batches.links.geometry.attributes.color.needsUpdate = true;
  }

  const m4 = new THREE.Matrix4();
  function place(mesh, list, scale) {
    list.forEach((n, i) => {
      const r = scale ?? nodeSize(n);
      m4.makeScale(r, r, r).setPosition(n.x || 0, n.y || 0, n.z || 0);
      mesh.setMatrixAt(i, m4);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }

  function updatePositions() {
    if (!batches) return;
    place(batches.spheres, batches.sphereNodes);
    place(batches.boxes, batches.boxNodes, 4);
    place(batches.rings, batches.ringNodes, 3.6);
    const rev = batches.rev.geometry.attributes.position.array;
    batches.revNodes.forEach((n, i) => {
      for (let v = 0; v < 24; v++) {
        const o = (i * 24 + v) * 3;
        rev[o] = (n.x || 0) + BOX_EDGES[v * 3] * 4;
        rev[o + 1] = (n.y || 0) + BOX_EDGES[v * 3 + 1] * 4;
        rev[o + 2] = (n.z || 0) + BOX_EDGES[v * 3 + 2] * 4;
      }
    });
    batches.rev.geometry.attributes.position.needsUpdate = true;
    const pos = batches.links.geometry.attributes.position.array;
    s.graph.links.forEach((l, i) => {
      const a = l.source;
      const b = l.target;
      pos.set([a.x || 0, a.y || 0, a.z || 0, b.x || 0, b.y || 0, b.z || 0], i * 6);
    });
    batches.links.geometry.attributes.position.needsUpdate = true;
    for (const obj of overlay.children) {
      const n = obj.userData.node;
      obj.position.set((n.x || 0) + (obj.userData.dx || 0), (n.y || 0) + (obj.userData.dy || 0), n.z || 0);
    }
  }

  let nodeById = new Map();

  // Selection halo and labels: few objects, rebuilt on selection changes.
  function buildOverlay() {
    for (const obj of overlay.children) obj.material?.dispose();
    overlay.clear();
    const sel = s.graph.nodes.find(n => n.id === s.selected);
    if (sel) {
      const halo = new THREE.Mesh(GEO_RING, new THREE.MeshBasicMaterial({ color: ACCENT, wireframe: true, transparent: true, opacity: 0.8 }));
      halo.scale.setScalar(nodeSize(sel) * 1.6);
      halo.userData.node = sel;
      overlay.add(halo);
    }
    let count = 0;
    for (const n of s.graph.nodes) {
      if (!wantsLabel(n)) continue;
      if (++count > LABEL_LIMIT) break;
      const sprite = labelSprite(n.label, n.id === s.selected ? TEXT : MUTED, n.kind === 'side' ? 0.022 : n.id === s.selected ? 0.034 : 0.028);
      sprite.userData = { node: n, dy: 0, dx: nodeSize(n) + 1 };
      overlay.add(sprite);
    }
    dirty = true;
  }

  function wantsLabel(n) {
    const lit = litSet(s);
    if (lit && lit.has(n.id)) return true;
    if (s.labels === 'all') return n.kind !== 'side';
    return s.labels === 'hubs' && s.hubs.has(n.id);
  }

  // --- emphasised links (drawn by 3d-force-graph, with width and particles) -------

  function emphasised(l) {
    const a = endId(l.source);
    const b = endId(l.target);
    if (s.highlight) return s.highlight.has(a) && s.highlight.has(b);
    return !!s.selected && (a === s.selected || b === s.selected);
  }

  function linkParticles(l) {
    if (s.particles === 'off' || !l.v || l.belowCut) return 0;
    if (emphasised(l)) return 3;
    return s.particles === 'visible' && s.fluxT(l.v) > 0.15 ? 1 : 0;
  }

  function emphasisedLink(l) {
    return (emphasised(l) && l.v > 0) || linkParticles(l) > 0;
  }

  function refreshLinks() {
    Graph
      .linkVisibility(emphasisedLink)
      .linkDirectionalParticles(linkParticles);
  }

  function restyle() {
    paint();
    buildOverlay();
    refreshLinks();
  }

  // --- quality ------------------------------------------------------------------------

  function chooseQuality() {
    const want = s.quality === 'auto'
      ? (s.graph.nodes.length > AUTO_FAST_NODES || lowFpsSeconds >= 3 ? 'fast' : 'high')
      : s.quality;
    if (want === effective) return;
    effective = want;
    if (batches) batches.spheres.geometry = effective === 'fast' ? GEO_FAST : GEO_HIGH;
  }

  // In fast mode, hide the bulk of the links while the camera moves.
  const controls = Graph.controls();
  controls.addEventListener?.('start', () => { if (effective === 'fast' && batches) batches.links.visible = false; });
  controls.addEventListener?.('end', () => { if (batches) batches.links.visible = true; });

  // --- interaction --------------------------------------------------------------------

  let lastClick = { id: null, t: 0 };
  function handleClick(n) {
    const now = performance.now();
    if (lastClick.id === n.id && now - lastClick.t < 400) flyTo(n.id);
    lastClick = { id: n.id, t: now };
    onNodeClick(n);
  }

  function flyTo(id, ms = 1200) {
    const n = nodeById.get(id);
    if (!n || n.x === undefined) return;
    const d = 80;
    const len = Math.hypot(n.x, n.y, n.z || 0) || 1;
    const r = 1 + d / len;
    Graph.cameraPosition({ x: n.x * r, y: n.y * r, z: (n.z || 0) * r || d }, n, ms);
  }

  function updateGrid() {
    const ns = s.graph.nodes.filter(n => n.x !== undefined);
    if (!ns.length) return;
    let minY = Infinity;
    let r = 50;
    for (const n of ns) {
      minY = Math.min(minY, n.y);
      r = Math.max(r, Math.hypot(n.x, n.y, n.z || 0));
    }
    grid.visible = s.grid;
    grid.scale.setScalar(r * 3);
    grid.position.y = minY - 20;
  }

  // --- frame loop: batched positions, auto-rotate, auto quality --------------------------

  let raf = 0;
  let frames = 0;
  let second = performance.now();
  (function tick() {
    if (dirty) {
      updatePositions();
      dirty = false;
    }
    if (s.rotate) {
      const cam = Graph.camera();
      const target = controls.target || new THREE.Vector3();
      const offset = cam.position.clone().sub(target);
      offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.003);
      cam.position.copy(target).add(offset);
      cam.lookAt(target);
    }
    frames++;
    const now = performance.now();
    if (now - second >= 1000) {
      lowFpsSeconds = frames < 25 ? lowFpsSeconds + 1 : 0;
      frames = 0;
      second = now;
      chooseQuality();
    }
    raf = requestAnimationFrame(tick);
  })();

  const resize = new ResizeObserver(() => Graph.width(el.clientWidth).height(el.clientHeight));
  resize.observe(el);

  // --- public API ----------------------------------------------------------------------

  return {
    dims: 3,
    get live() { return layout.live; },
    qualityText: () => (s.quality === 'auto' ? `auto: ${effective}` : effective),
    setData(graph, { styles, live }) {
      const old = new Map(s.graph.nodes.map(n => [n.id, n]));
      const degree = degrees(graph);
      for (const n of graph.nodes) {
        n.degree = degree.get(n.id) || 0;
        const prev = old.get(n.id);
        if (prev && n.x === undefined) Object.assign(n, { x: prev.x, y: prev.y, z: prev.z });
      }
      const fresh = placeFresh(graph, 3);
      nodeById = new Map(graph.nodes.map(n => [n.id, n]));
      // Resolve endpoints to node objects ourselves: with the link force
      // removed (frozen layout) the library no longer does it.
      for (const l of graph.links) {
        l.source = nodeById.get(endId(l.source));
        l.target = nodeById.get(endId(l.target));
      }
      s.fluxT = fluxScale(graph.links);
      s.hubs = new Set(graph.nodes.filter(n => n.kind === 'met').sort((a, b) => b.degree - a.degree).slice(0, 30).map(n => n.id));
      s.graph = graph;
      s.styles = styles;
      s.selected = nodeById.has(s.selected) ? s.selected : null;
      s.focus = focusSet(graph, s.selected);
      lowFpsSeconds = 0;
      chooseQuality();
      Graph.graphData(graph);
      layout.afterData(fresh, live || fresh.length === graph.nodes.length);
      buildBatches();
      buildOverlay();
      updateGrid();
    },
    setSelection(id) {
      s.selected = id && nodeById.has(id) ? id : null;
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
      if (key === 'grid') updateGrid();
      else if (key === 'cluster') { if (layout.live) Graph.d3ReheatSimulation(); }
      else if (key === 'rotate') Graph.enableNavigationControls(!value);
      else if (key === 'drag') Graph.enableNodeDrag(value);
      else if (key === 'quality') { lowFpsSeconds = 0; chooseQuality(); }
      else restyle();
    },
    zoom(factor) {
      const cam = Graph.camera();
      const target = controls.target || new THREE.Vector3();
      const p = cam.position.clone().sub(target).multiplyScalar(factor).add(target);
      Graph.cameraPosition({ x: p.x, y: p.y, z: p.z }, target, 300);
    },
    fit() { Graph.zoomToFit(600, 40); },
    flyTo,
    positions() {
      const out = {};
      for (const n of s.graph.nodes) {
        if (n.x !== undefined) out[n.id] = [n.x, n.y, n.z || 0];
      }
      return out;
    },
    screenshot() {
      Graph.renderer().render(scene, Graph.camera());
      return Graph.renderer().domElement.toDataURL('image/png');
    },
    destroy() {
      cancelAnimationFrame(raf);
      resize.disconnect();
      disposeBatches();
      Graph._destructor();
      el.replaceChildren();
    },
  };
}
