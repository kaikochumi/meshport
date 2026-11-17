// Search and sort run over the list the popup already scanned. No platform
// call happens per keystroke; this file only rearranges entries in memory.
function librarySearchText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

// Newest first needs a date the list can trust. Tripo library entries carry
// the project creation time as an ISO string, Meshy entries a task time, and
// captured entries a millisecond timestamp; accept all three.
function libraryTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? value * 1000 : value;
  }
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text)) return libraryTimestamp(Number(text));
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function libraryEntryDate(entry) {
  return libraryTimestamp(entry?.createdAt) || libraryTimestamp(entry?.capturedAt);
}

function filterLibraryEntries(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const titleOf = typeof options.titleOf === "function"
    ? options.titleOf
    : (entry) => entry?.name || entry?.projectId || entry?.url || "";
  const query = librarySearchText(options.query || "");
  const sort = options.sort === "name" ? "name" : "date";

  const rows = list.map((entry, index) => ({ entry, index, title: titleOf(entry) }));
  const filtered = query
    ? rows.filter((row) => librarySearchText(row.title).includes(query))
    : rows;

  filtered.sort((a, b) => {
    if (sort === "name") {
      const byName = a.title.localeCompare(b.title, undefined, {
        sensitivity: "base",
        numeric: true,
      });
      return byName || a.index - b.index;
    }
    const byDate = libraryEntryDate(b.entry) - libraryEntryDate(a.entry);
    return byDate || a.index - b.index;
  });

  return filtered.map((row) => row.entry);
}

globalThis.MeshportLibraryFilter = {
  filterLibraryEntries,
  libraryEntryDate,
  librarySearchText,
  libraryTimestamp,
};
