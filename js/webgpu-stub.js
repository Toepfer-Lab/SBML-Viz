// Stands in for three/webgpu (see the import map in index.html). three-render-objects
// imports it for an optional WebGPU renderer that the app never asks for; the real
// build bundles its own copy of three.js, which would then load twice.
export class WebGPURenderer {
  constructor() {
    throw new Error('The WebGPU renderer is not included in SBML Viz.');
  }
}
