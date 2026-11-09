// Parses SBML off the main thread. In: { file } or { url }. Out: progress
// messages, then { type: 'done', model } or { type: 'error', message }.
import { parseSBML } from './model.js';

self.onmessage = async ({ data }) => {
  try {
    self.postMessage({ type: 'progress', stage: 'Reading', fraction: 0 });
    let text;
    if (data.file) {
      text = await data.file.text();
    } else {
      const res = await fetch(data.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    }
    let lastSent = 0;
    const model = parseSBML(text, fraction => {
      if (fraction - lastSent >= 0.02 || fraction === 1) {
        lastSent = fraction;
        self.postMessage({ type: 'progress', stage: 'Parsing', fraction });
      }
    });
    self.postMessage({ type: 'done', model });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
