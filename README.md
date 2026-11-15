# Meshport

Meshport is a browser extension that exports models from your Tripo Studio library. It reads the library with the session already open in Tripo, fetches each model, decodes it in the browser, and saves it as STL, OBJ, glTF, GLB, or a folder of textures.

Built by [@kaikochumi](https://github.com/kaikochumi).

![Meshport popup](docs/popup.png)

Every model in My Assets and Collected appears with its Tripo cover. Models without a cover get a preview rendered from the GLB.

Tripo serves models with `EXT_meshopt_compression` and `KHR_mesh_quantization`. Blender, PrusaSlicer, and other tools do not open those files. Meshport removes both extensions before it writes the output, so the result opens elsewhere.

## Install

Meshport is not on the Chrome Web Store. Load it from the folder:

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
3. Turn on `Developer mode`.
4. Click `Load unpacked` and select the `chrome-extension` folder.
5. Pin Meshport to the toolbar if the icon is hidden.

To update, replace the folder and click the reload button on the extensions page.

## Usage

1. Open [Tripo Studio](https://studio.tripo3d.ai) and sign in.
2. Reload the Tripo tab after installing or updating Meshport, so the new content script is active.
3. Click the Meshport icon. The popup lists My Assets and Collected, newest first.
4. Pick a model, change the file name if you want, and choose a format.
5. Click the download button.

The list scrolls. The number next to MODEL shows how many models the library returned.

If the library request fails, Meshport falls back to the GLBs it has seen in the open tab.

The Settings tab sets a subfolder inside Downloads, switches the download to ask for a folder each time, and picks the default format.

`Inspect` decodes the model without saving it and shows the textures, their sizes, and the triangle count.

Tripo model links are signed and expire after a few minutes. Meshport asks for a fresh link when a download fails with 403.

## Formats

| Format | Files |
| --- | --- |
| STL | Binary STL with geometry only. |
| OBJ | A zip with the `.obj`, `.mtl`, and a `textures` folder. |
| glTF | A zip with the `.gltf`, `.bin`, and a `textures` folder. |
| GLB | One decoded GLB, without meshopt or quantization. |
| Textures | A zip with every embedded texture. |

STL cannot store textures. Use OBJ or glTF when you need the maps.

## Notes

- Everything runs in the extension. Models and textures never leave the browser.
- Meshport uses the Tripo session already active in your browser. It does not read your password or store a token.
- Textures keep their original format unless `Convert textures to PNG` is on. PNG opens in more editors and takes more space.
- OBJ export writes UVs, a material library, and applies the `KHR_texture_transform` declared by each material.
- The popup remembers the format and the PNG setting. It does not remember the file name because that belongs to the model.
- Browsers can only write inside the Downloads folder. The Settings tab can put files in a subfolder there, or ask where to save each download.
- Covers come from the Tripo library. When a model has no cover, the preview is rendered locally and cached, so the popup opens faster the next time.
- The GLB export is decoded, not re-encoded.
- Download only models you have the right to use.

## Development

```bash
npm install
npm test
```

The suite covers the GLB parser, texture extraction, OBJ and MTL output, the zip writer, the glTF package builder, the meshopt decode path, and the library card parsing. It runs against `test/fixtures/cube-meshopt.glb`, a cube compressed with `gltfpack -cc`.

Rebuild the decoder bundle after upgrading glTF Transform or meshoptimizer:

```bash
npm run build:vendor
```

Regenerate the fixture:

```bash
npm run make:fixture
```

`chrome-extension/vendor/tripo_loader.js` is generated from `tools/vendor-entry.js` and bundles `@gltf-transform/core`, `@gltf-transform/extensions`, and the meshoptimizer decoder. Licenses are in `THIRD_PARTY_NOTICES.md`.

## Credits

Built by [@kaikochumi](https://github.com/kaikochumi). The exporters started in [Meshy AI to STL](https://github.com/ChesterTheCatt/meshy-ai-to-stl) and were adapted for Tripo Studio. [@ChesterTheCatt](https://github.com/ChesterTheCatt) wrote the original extension.
