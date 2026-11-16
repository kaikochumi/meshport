# Contributing

Bug reports and pull requests are welcome.

## Reporting a bug

Open an issue with the bug report template. The console output decides most of these: right-click the Meshport icon, choose `Inspect popup`, and open the Console tab. The `[Meshport]` lines show which link was picked and why, and `JSON.parse(localStorage["meshport/last-download"])` in that same console replays the whole download decision.

## Development

```bash
npm install
npm test
```

The unit suite covers the GLB parser, texture extraction, OBJ and MTL output, the zip writer, the glTF package builder, the meshopt decode path, library card parsing, and model file detection. It runs against `test/fixtures/cube-meshopt.glb`, a cube compressed with `gltfpack -cc`. `npm run make:fixture` regenerates it.

`npm run test:e2e` drives a real browser through both platforms: the Tripo library, the Meshy scan, the platform round trip, and a full Meshy download from the converter sandbox to a saved file. It looks for Edge in the standard install location; set `MESHPORT_EDGE_PATH` when it lives somewhere else.

To try changes by hand, load the folder as an unpacked extension: `chrome://extensions`, developer mode, `Load unpacked`, select `chrome-extension`. Reload the extension and the Tripo or Meshy tab after every code change, because content scripts do not re-inject into open tabs.

Rebuild the decoder bundle after upgrading glTF Transform or meshoptimizer:

```bash
npm run build:vendor
```

`chrome-extension/vendor/tripo_loader.js` is generated from `tools/vendor-entry.js` and bundles `@gltf-transform/core`, `@gltf-transform/extensions`, and the meshoptimizer decoder.

## Pull requests

Keep one idea per pull request. Run `npm test` before you push, and include the console lines when the change touches downloads. Match the code around you: plain functions, comments that say why, and error messages that tell the person what to do next.
