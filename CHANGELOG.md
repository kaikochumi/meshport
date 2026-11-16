# Changelog

All notable changes to Meshport are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.0] - 2026-11-16

### Added

- Meshy as a second source. The popup switches between Tripo and Meshy, and each platform keeps its own list, selection, and theme.
- Meshy reading runs inside the tab: the workspace already fetched the model status and the library, and a page-world script hands those answers to the extension, which never calls the Meshy API and needs no login or key.
- Meshy exports as STL, OBJ, glTF, GLB, or a zip of textures, with the render Meshy already made as the thumbnail.
- An inline Rescan button on the Meshy empty state, matching the Reload tab button on Tripo.

### Changed

- The thumbnail cache writes once per scan instead of once per card, and Meshy previews are stored at card size, so the cache stays small and survives the storage quota.
- Meshy error messages carry the Meshport version, so a stale tab reads differently from a live failure.

### Fixed

- The first Meshy download died with a transferable-type error before any bytes moved.

## [0.3.4] - 2026-11-16

### Added

- First public release. Reads the Tripo Studio library already open in the browser and saves models as STL, OBJ, glTF, GLB, FBX, or a zip of textures.
- Output ships without `EXT_meshopt_compression` or `KHR_mesh_quantization`, so Blender, slicers, and game engines open the files right away.
- Native FBX path that downloads Tripo's stored file with quad topology intact.
- Content-verified downloads: every GLB is probed for the ids Tripo embeds inside the file, so a preview of another asset never wins.
- Settings tab with a download subfolder, an ask-where-to-save switch, and a default format.

[0.4.0]: https://github.com/kaikochumi/meshport/releases/tag/v0.4.0
[0.3.4]: https://github.com/kaikochumi/meshport/releases/tag/v0.3.4
