// The export queue is plain state. Items move between waiting, processing,
// completed, failed, and cancelled; popup.js hands in the runner that does the
// actual download, so this file never touches the DOM, chrome.downloads, or a
// platform API. That keeps the whole state machine testable in plain Node.
const QUEUE_STATES = Object.freeze({
  waiting: "waiting",
  processing: "processing",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
});

const QUEUE_INTERRUPTED = "The popup closed before this export finished. Retry when ready.";

function createExportQueue(options = {}) {
  const run = typeof options.run === "function" ? options.run : null;
  const persist = typeof options.persist === "function" ? options.persist : null;
  const onChange = typeof options.onChange === "function" ? options.onChange : () => {};
  const items = [];
  let running = false;
  let counter = 0;

  function snapshotItem(item) {
    return {
      id: item.id,
      key: item.key,
      name: item.name,
      platform: item.platform,
      format: item.format,
      status: item.status,
      detail: item.detail,
      savedAs: item.savedAs,
      baseName: item.baseName,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      entry: item.entry,
    };
  }

  function serializable() {
    return items.map(snapshotItem);
  }

  function summary() {
    const counts = {
      waiting: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const item of items) counts[item.status] += 1;
    return {
      total: items.length,
      ...counts,
      done: counts.completed + counts.failed + counts.cancelled,
    };
  }

  function changed() {
    if (persist) {
      try {
        persist(serializable());
      } catch {
        // Persistence is best effort; the queue still lives in memory.
      }
    }
    try {
      onChange();
    } catch {
      // The view should never take the queue down.
    }
  }

  function snapshot() {
    return {
      items: items.map(snapshotItem),
      running,
      summary: summary(),
    };
  }

  // A model already waiting or exporting is skipped. Finished items are not
  // deduped: exporting one again is an explicit new request.
  function add(candidates = []) {
    const activeKeys = new Set(
      items
        .filter((item) => item.status === QUEUE_STATES.waiting || item.status === QUEUE_STATES.processing)
        .map((item) => item.key),
    );
    let added = 0;
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const key = typeof candidate?.key === "string" ? candidate.key : "";
      if (!key || activeKeys.has(key)) continue;
      activeKeys.add(key);
      const now = Date.now();
      items.push({
        id: `item-${now.toString(36)}-${++counter}`,
        key,
        name: String(candidate.name || "model"),
        platform: candidate.platform === "meshy" ? "meshy" : "tripo",
        format: typeof candidate.format === "string" ? candidate.format : "stl",
        status: QUEUE_STATES.waiting,
        detail: "",
        savedAs: "",
        createdAt: now,
        updatedAt: now,
        entry: candidate.entry || null,
      });
      added += 1;
    }
    if (added) changed();
    return added;
  }

  function find(id) {
    return items.find((item) => item.id === id) || null;
  }

  // Only tasks that have not started can be cancelled. A running conversion
  // has no reliable abort path, and pretending otherwise would lie.
  function cancel(id) {
    const item = find(id);
    if (!item || item.status !== QUEUE_STATES.waiting) return false;
    item.status = QUEUE_STATES.cancelled;
    item.detail = "";
    item.updatedAt = Date.now();
    changed();
    return true;
  }

  function retry(id) {
    const item = find(id);
    if (!item || (item.status !== QUEUE_STATES.failed && item.status !== QUEUE_STATES.cancelled)) {
      return false;
    }
    if (items.some((other) => other !== item && other.key === item.key
      && (other.status === QUEUE_STATES.waiting || other.status === QUEUE_STATES.processing))) {
      return false;
    }
    item.status = QUEUE_STATES.waiting;
    item.detail = "";
    item.updatedAt = Date.now();
    changed();
    return true;
  }

  function clearFinished() {
    let removed = 0;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (
        items[index].status === QUEUE_STATES.completed
        || items[index].status === QUEUE_STATES.cancelled
      ) {
        items.splice(index, 1);
        removed += 1;
      }
    }
    if (removed) changed();
    return removed;
  }

  function hasWaiting() {
    return items.some((item) => item.status === QUEUE_STATES.waiting);
  }

  async function drain() {
    try {
      for (;;) {
        const item = items.find((entry) => entry.status === QUEUE_STATES.waiting);
        if (!item) break;
        item.status = QUEUE_STATES.processing;
        item.detail = "Starting...";
        item.updatedAt = Date.now();
        changed();
        try {
          await run(item, {
            setDetail: (text) => {
              if (item.status !== QUEUE_STATES.processing) return;
              item.detail = String(text || "");
              item.updatedAt = Date.now();
              changed();
            },
          });
          // A completed state is only written after the runner resolved,
          // which only happens once the download was accepted.
          if (item.status === QUEUE_STATES.processing) {
            item.status = QUEUE_STATES.completed;
            item.detail = item.savedAs ? `${item.savedAs} saved.` : "Saved.";
            item.updatedAt = Date.now();
          }
        } catch (error) {
          if (item.status === QUEUE_STATES.processing) {
            item.status = QUEUE_STATES.failed;
            item.detail = error?.message || String(error || "Export failed.");
            item.updatedAt = Date.now();
          }
        }
        changed();
      }
    } finally {
      running = false;
      changed();
    }
  }

  function start() {
    if (running || !run) return Promise.resolve(snapshot());
    running = true;
    changed();
    return drain().then(snapshot);
  }

  // Anything that was mid-flight when the popup closed comes back as failed,
  // never as completed: the download was never confirmed.
  function restore(stored) {
    if (!Array.isArray(stored)) return;
    items.length = 0;
    const activeKeys = new Set();
    for (const raw of stored) {
      if (!raw || typeof raw !== "object") continue;
      const status = Object.values(QUEUE_STATES).includes(raw.status)
        ? raw.status
        : QUEUE_STATES.waiting;
      const key = typeof raw.key === "string" ? raw.key : "";
      if (!key) continue;
      const recovered = status === QUEUE_STATES.processing ? QUEUE_STATES.failed : status;
      const duplicate = recovered === QUEUE_STATES.waiting && activeKeys.has(key);
      if (recovered === QUEUE_STATES.waiting && !duplicate) activeKeys.add(key);
      items.push({
        id: typeof raw.id === "string" && raw.id ? raw.id : `item-restored-${++counter}`,
        key,
        name: String(raw.name || "model"),
        platform: raw.platform === "meshy" ? "meshy" : "tripo",
        format: typeof raw.format === "string" ? raw.format : "stl",
        status: duplicate ? QUEUE_STATES.failed : recovered,
        detail: duplicate ? "Duplicate active export; retry after the other finishes."
          : status === QUEUE_STATES.processing ? QUEUE_INTERRUPTED : String(raw.detail || ""),
        savedAs: String(raw.savedAs || ""),
        baseName: typeof raw.baseName === "string" ? raw.baseName : "",
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Date.now(),
        entry: raw.entry && typeof raw.entry === "object" ? raw.entry : null,
      });
    }
    changed();
  }

  return {
    add,
    cancel,
    retry,
    clearFinished,
    start,
    restore,
    snapshot,
    summary,
    hasWaiting,
    isRunning: () => running,
  };
}

// Two models can share a name inside one batch. The first keeps it; the next
// gets a numeric suffix, compared case-insensitively like a file system would.
function nextUniqueName(used, base) {
  const names = used instanceof Set ? used : new Set();
  const clean = String(base || "model").trim() || "model";
  const taken = (value) => names.has(value.toLowerCase());
  let candidate = clean;
  let index = 2;
  while (taken(candidate)) {
    candidate = `${clean}-${index}`;
    index += 1;
  }
  names.add(candidate.toLowerCase());
  return candidate;
}

globalThis.MeshportExportQueue = {
  createExportQueue,
  nextUniqueName,
  QUEUE_STATES,
  QUEUE_INTERRUPTED,
};
