# Tripo To STL

Tripo To STL is a Chrome extension for models you open in Tripo Studio. It catches the GLB the page downloads, decodes it in the browser, and saves it as STL, OBJ, glTF, GLB, or a folder of textures.

Tripo serves models as GLB files compressed with `EXT_meshopt_compression` and quantized with `KHR_mesh_quantization`. The extension removes both before exporting, so the result opens in Blender, PrusaSlicer, and other tools that do not support those extensions.

## Requirements

Google Chrome or another Chromium browser. No account setup and no server. The decoder ships inside `chrome-extension/vendor`, so there is nothing to build before loading the extension.

## Installation

1. Open `chrome://extensions`.
2. Turn on `Developer mode`.
3. Click `Load unpacked`.
4. Pick the `chrome-extension` folder inside this project.

## Usage

1. Open a model in Tripo Studio.
2. Reload the page if the extension was installed after the model loaded. It only sees requests made while it is running.
3. Click the Tripo To STL icon.
4. Pick one of the detected GLB files. The newest model stays at the top of the list.
5. Change the file name if you want.
6. Pick a format and click the download button.

`Inspect textures` shows the maps and their sizes before you download anything.

Tripo links are signed and stop working after a few minutes. If the extension reports a 403, reload the model page and try again.

## Output formats

| Format | What you get |
| --- | --- |
| STL | Binary STL with geometry only. STL cannot store textures. |
| OBJ + textures | A `.zip` with the `.obj`, an `.mtl`, and a `textures/` folder. |
| glTF + textures | A `.zip` with the `.gltf`, its `.bin`, and a `textures/` folder. |
| GLB | The decoded model as one GLB, without meshopt or quantization. |
| Textures only | A `.zip` with every embedded texture. |

## Notes

- Everything runs inside the extension. Model data never leaves the browser.
- Textures keep their original format unless `Convert textures to PNG` is checked. PNG opens in more editors and takes more space.
- OBJ export writes UVs and an `.mtl` that points at the exported images. It also applies the UV set and `KHR_texture_transform` declared by each material.
- The popup remembers the format and the PNG setting between sessions. The file name is not remembered because it belongs to the model you picked.
- Tripo limits exports on some plans. Download only models you have the right to use.
- The extension is not on the Chrome Web Store. Update it by replacing the folder and clicking reload in `chrome://extensions`.
- The GLB export is the decoded model. Nothing is re-encoded.

## Development

```bash
npm install
npm test
```

The suite covers the GLB parser, texture extraction, OBJ/MTL output, the ZIP writer, the glTF package builder, and the meshopt decode path. It runs against `test/fixtures/cube-meshopt.glb`, a small cube compressed with `gltfpack -cc`.

Rebuild the decoder bundle after upgrading glTF Transform or meshoptimizer:

```bash
npm run build:vendor
```

Regenerate the test fixture:

```bash
npm run make:fixture
```

`chrome-extension/vendor/tripo_loader.js` is generated from `tools/vendor-entry.js` and bundles `@gltf-transform/core`, `@gltf-transform/extensions`, and the meshoptimizer decoder. Licenses are listed in `THIRD_PARTY_NOTICES.md`.
