# Changelog

All notable changes to Meshport are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.5.0] - 2026-11-17

### Added

- Batch export from the Tripo and Meshy libraries. Tick models, use `Select all` for the current search, pick one format, and send the selection to the export queue.
- Meshy now lists the whole workspace library. Finished models keep the signed links the workspace page already fetched, so they can be searched, selected, and queued without opening each one.
- Export queue view with waiting, exporting, completed, failed, and cancelled states per item, live details, and a header badge that counts unfinished work.
- Cancel waiting items, retry failures, and clear finished work without touching the rest of the queue.
- Queue persistence in `chrome.storage.session`. A popup reload keeps finished items, and an export that was mid-flight returns as failed with an interrupted message.
- Search by name over the last scan, case and accent insensitive, plus sort by newest or by name.
- Multi-select that survives search and sort. Hidden models are never exported, and the Export button counts only the visible selection.

### Changed

- Single downloads and batch items share the same fetch, verify, convert, and save path, so a batch goes through the same content checks.
- Each Meshy model's signed GLB link is read from the library answers the workspace page already received, so a batch can include models the page never opened. An expired link is refreshed by re-reading the library.
- Batch export never opens or navigates the user's Tripo tab. A model Tripo cannot resolve as a GLB says so and the rest of the queue continues.
- The popup subtitle and manifest description now cover Tripo, Meshy, and queued batches.

### Fixed

- Meshy task dates are parsed from ISO strings or epoch values, so newest-first sorting uses the real creation time.
- Author display rules no longer override the `hidden` attribute on the new flex and grid controls.
- A textured Meshy task exports the textured mesh, not the auto-UV base that shares the same result object.
- A retried queue item keeps the file name it used before the popup closed, instead of picking a new suffix.
- Switching platforms during a library scan no longer re-enables the controls early, and a stale scan cannot overwrite the library that is open now.
- The Meshy scan no longer lets the extension's direct `/v2/tasks` call erase signed links that only the workspace's authenticated answer carries. The page also replays its captured library when the content script starts late, and filtered list pages accumulate instead of replacing the full list.
- Meshy multi-select now leaves models with no download link out of the selection, marks their card `Open once in Meshy`, and skips any that still reach the queue, instead of failing them one by one after the batch starts.

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

[0.5.0]: https://github.com/kaikochumi/meshport/releases/tag/v0.5.0
[0.4.0]: https://github.com/kaikochumi/meshport/releases/tag/v0.4.0
[0.3.4]: https://github.com/kaikochumi/meshport/releases/tag/v0.3.4
