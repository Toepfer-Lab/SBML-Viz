# SBML Viz

3D force-directed viewer for SBML metabolic models, with optional flux
distributions drawn as flow along each reaction.

## Run

ES modules and `fetch` need HTTP, so serve the folder instead of opening
`index.html` directly:

```bash
npm start          # python3 -m http.server 8000
```

Then open <http://localhost:8000>.

- `?example`: load the bundled plant model (with flux)
- `?model=<url>&flux=<url>`: load an SBML file and optional flux CSV by URL
- `&focus=<id>`: open that species' or reaction's neighbourhood as a 2D map
- `&from=<id>&to=<id>`: find and show a path between two species
- `&vmin=<|v|>&vmax=<|v|>`: only show reactions whose |flux| lies in this range

## Layout

A layout is computed in a Web Worker before the graph is drawn, until the
simulation runs out of energy. Meanwhile the graph area shows progress and is
locked, while the side panels stay usable; *Stop now* shows the layout as far
as it got. Once drawn, the layout is frozen: every node is pinned, and dragging
moves only that node. *Run forces* runs the forces again on screen, from where
the graph is. A few nodes added later (a growing neighbourhood) settle on
screen too; many added at once are laid out in the worker around the others.

2D and 3D are independent: each gets its own layout the first time it is
shown, and switching back restores it. The browser remembers the latest layout
of the last ten models (IndexedDB), so reopening a model shows it as it was
left; *Lay out again* in the message that appears computes a new one. *Save
layout* additionally keeps a snapshot that *Restore layout* returns to.

## Input

- **SBML** (L2/L3, FBC bounds and reversibility are read). Drop the file anywhere or use *Open model…*.
- **Flux CSV**: `reaction_id,flux` per row (comma, semicolon or tab; header optional).
  IDs match as shown, as written in the SBML file, with or without the `R_` prefix, or once both
  encodings below are decoded on both sides. A row that fits several reactions only after
  decoding is skipped and reported.
- **ID decoding** (the *ID decoding* tab): two encodings are detected and decoded automatically.
  - cobrapy: `M_`/`R_`/`G_` prefixes and characters as codes (`M_P_C00001__91__m__93__` → `P_C00001[m]`),
    the way cobrapy shows IDs after loading.
  - COBRA Toolbox: tokens such as `_PERIOD_`, `_DASH_`, `_LSQBKT_`. Current cobrapy keeps these, so
    untick this one to see IDs exactly as cobrapy does.

  Where a decoding step would make two IDs equal, it is skipped for the ID it would change; the tab
  lists every ID before and after, with clashes and unmatched flux rows under *Problems*.

## Layout

| Path | Purpose |
| --- | --- |
| `js/model.js` | SBML parser (no DOM; annotations, notes, genes, groups), flux CSV parser, bundled-example converter |
| `js/parse-worker.js` | Runs the SBML parser in a Web Worker with progress |
| `js/graph.js` | Pure graph building: scope/hops, side metabolites, flux threshold, compartments; path finding |
| `js/layout.js` | Force settings, frozen layout and placement of a few new nodes, shared by both views |
| `js/layout-worker.js` | Computes layouts off the main thread until the simulation runs out of energy |
| `js/layout-store.js` | Remembers the latest layout per model in IndexedDB |
| `js/view.js` | 3D overview: 3d-force-graph for layout and picking, batched (instanced) three.js drawing |
| `js/view2d.js` | 2D reaction map: force-graph canvas rendering |
| `js/style.js` | Shared visual language (colors, flux scale, cluster force) |
| `js/ui.js` | Side-panel rendering |
| `js/main.js` | App state and event wiring |
| `data/example-model.json` | Bundled example (pre-built graph; link value = stoichiometry × flux) |

Libraries come from jsDelivr via the import map in `index.html`. Keep
`3d-force-graph` and `three` on versions whose bundles reference the same
three.js URL, or three.js loads twice. For the same reason the import map
points `three/webgpu` (an optional renderer in three-render-objects, with its
own copy of three.js) at `js/webgpu-stub.js`; update that URL with `three`.

## Test

```bash
npm test
```
