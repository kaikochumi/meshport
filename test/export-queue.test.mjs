import test from "node:test";
import assert from "node:assert/strict";
import "../chrome-extension/export-queue.js";

const {
  createExportQueue,
  nextUniqueName,
  QUEUE_STATES,
  QUEUE_INTERRUPTED,
} = globalThis.MeshportExportQueue;

function candidate(name, key = name.toLowerCase()) {
  return { key, name, platform: "tripo", format: "stl", entry: { projectId: key } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("add skips a key that is already waiting and returns how many landed", () => {
  const queue = createExportQueue({ run: async () => {} });
  assert.equal(queue.add([candidate("Street Van"), candidate("street van")]), 1);
  assert.equal(queue.add([candidate("Street Van")]), 0);
  assert.equal(queue.snapshot().items.length, 1);
});

test("add accepts the same key again after the first export finished", async () => {
  const queue = createExportQueue({ run: async () => {} });
  queue.add([candidate("Street Van")]);
  await queue.start();
  assert.equal(queue.add([candidate("Street Van")]), 1);
  assert.equal(queue.snapshot().items.length, 2);
});

test("start drains one item at a time and marks completed only after the runner resolves", async () => {
  const gate = deferred();
  const started = [];
  const queue = createExportQueue({
    run: async (item) => {
      started.push(item.name);
      if (item.name === "One") await gate.promise;
      item.savedAs = `${item.name}.stl`;
    },
  });
  queue.add([candidate("One"), candidate("Two")]);

  const startedAll = queue.start();
  assert.deepEqual(started, ["One"], "the second item waits for the first");
  let snapshot = queue.snapshot();
  assert.equal(snapshot.items[0].status, QUEUE_STATES.processing);
  assert.equal(snapshot.items[1].status, QUEUE_STATES.waiting);
  assert.equal(snapshot.summary.processing, 1);
  assert.equal(snapshot.summary.waiting, 1);

  gate.resolve();
  await startedAll;
  assert.deepEqual(started, ["One", "Two"]);
  snapshot = queue.snapshot();
  assert.equal(snapshot.items[0].status, QUEUE_STATES.completed);
  assert.equal(snapshot.items[0].detail, "One.stl saved.");
  assert.equal(snapshot.items[1].status, QUEUE_STATES.completed);
  assert.equal(snapshot.running, false);
  assert.deepEqual(snapshot.summary, {
    total: 2,
    waiting: 0,
    processing: 0,
    completed: 2,
    failed: 0,
    cancelled: 0,
    done: 2,
  });
});

test("a rejected runner becomes failed with its message and retry brings it back", async () => {
  const attempts = [];
  const queue = createExportQueue({
    run: async (item) => {
      attempts.push(item.name);
      if (attempts.length === 1) throw new Error("Download failed: 403");
    },
  });
  queue.add([candidate("Chair")]);
  await queue.start();

  let snapshot = queue.snapshot();
  assert.equal(snapshot.items[0].status, QUEUE_STATES.failed);
  assert.equal(snapshot.items[0].detail, "Download failed: 403");

  assert.equal(queue.retry(snapshot.items[0].id), true);
  assert.equal(queue.snapshot().items[0].status, QUEUE_STATES.waiting);
  await queue.start();
  snapshot = queue.snapshot();
  assert.equal(snapshot.items[0].status, QUEUE_STATES.completed);
  assert.deepEqual(attempts, ["Chair", "Chair"]);
});

test("a waiting item can be cancelled and never reaches the runner", async () => {
  const started = [];
  const queue = createExportQueue({
    run: async (item) => {
      started.push(item.name);
    },
  });
  queue.add([candidate("One"), candidate("Two")]);
  const second = queue.snapshot().items[1];
  assert.equal(queue.cancel(second.id), true);
  assert.equal(queue.cancel(second.id), false, "cancelling twice is a no-op");
  assert.equal(queue.cancel(queue.snapshot().items[0].id), true);

  await queue.start();
  assert.deepEqual(started, []);
  const snapshot = queue.snapshot();
  assert.equal(snapshot.items[0].status, QUEUE_STATES.cancelled);
  assert.equal(snapshot.items[1].status, QUEUE_STATES.cancelled);
  assert.equal(snapshot.summary.cancelled, 2);
});

test("a processing item cannot be cancelled from the state machine", async () => {
  const gate = deferred();
  const queue = createExportQueue({ run: () => gate.promise });
  queue.add([candidate("One")]);
  const started = queue.start();
  const item = queue.snapshot().items[0];
  assert.equal(queue.cancel(item.id), false);
  gate.resolve();
  await started;
  assert.equal(queue.snapshot().items[0].status, QUEUE_STATES.completed);
});

test("clearFinished drops completed and cancelled items but keeps failures", async () => {
  let calls = 0;
  const queue = createExportQueue({
    run: async (item) => {
      calls += 1;
      if (item.name === "Bad") throw new Error("nope");
    },
  });
  queue.add([candidate("Good"), candidate("Bad"), candidate("Later")]);
  const ids = queue.snapshot().items.map((item) => item.id);
  queue.cancel(ids[2]);
  await queue.start();

  assert.equal(queue.snapshot().items.length, 3);
  assert.equal(queue.clearFinished(), 2);
  const left = queue.snapshot().items;
  assert.equal(left.length, 1);
  assert.equal(left[0].name, "Bad");
  assert.equal(left[0].status, QUEUE_STATES.failed);
  assert.equal(queue.clearFinished(), 0);
});

test("restore turns an interrupted export into failed, never completed", () => {
  const queue = createExportQueue({ run: async () => {} });
  queue.restore([
    { id: "a", key: "a", name: "One", status: QUEUE_STATES.processing, savedAs: "one.stl" },
    { id: "b", key: "b", name: "Two", status: QUEUE_STATES.waiting },
    { id: "c", key: "c", name: "Three", status: QUEUE_STATES.completed, savedAs: "three.stl" },
    null,
    { id: "d", key: "d", name: "Four", status: "nonsense" },
  ]);
  const snapshot = queue.snapshot();
  assert.equal(snapshot.items.length, 4);
  assert.equal(snapshot.items[0].status, QUEUE_STATES.failed);
  assert.equal(snapshot.items[0].detail, QUEUE_INTERRUPTED);
  assert.equal(snapshot.items[0].savedAs, "one.stl");
  assert.equal(snapshot.items[1].status, QUEUE_STATES.waiting);
  assert.equal(snapshot.items[2].status, QUEUE_STATES.completed);
  assert.equal(snapshot.items[3].status, QUEUE_STATES.waiting, "unknown states fall back to waiting");
  assert.equal(snapshot.summary.failed, 1);
  assert.equal(snapshot.summary.waiting, 2);
});

test("persist receives the serialized queue after every change", async () => {
  const saves = [];
  const queue = createExportQueue({
    run: async (item) => {
      item.savedAs = "one.stl";
    },
    persist: (items) => saves.push(items),
  });
  queue.add([candidate("One")]);
  await queue.start();
  assert.ok(saves.length >= 2);
  const last = saves[saves.length - 1];
  assert.equal(last.length, 1);
  assert.equal(last[0].status, QUEUE_STATES.completed);
  assert.equal(last[0].savedAs, "one.stl");
});

test("a base name assigned by the runner survives persistence and restore", async () => {
  const saves = [];
  const queue = createExportQueue({
    run: async (item) => {
      item.baseName = "Street Van";
      item.savedAs = "Street Van.stl";
    },
    persist: (items) => saves.push(items),
  });
  queue.add([candidate("Street Van")]);
  await queue.start();

  const last = saves[saves.length - 1];
  assert.equal(last[0].baseName, "Street Van");

  const restored = createExportQueue({ run: async () => {} });
  restored.restore(last);
  assert.equal(restored.snapshot().items[0].baseName, "Street Van");
});

test("persist failures never take the queue down", async () => {
  const queue = createExportQueue({
    run: async () => {},
    persist: () => {
      throw new Error("quota");
    },
  });
  queue.add([candidate("One")]);
  await queue.start();
  assert.equal(queue.snapshot().summary.completed, 1);
});

test("start without a runner leaves items waiting", async () => {
  const queue = createExportQueue();
  queue.add([candidate("One")]);
  await queue.start();
  const snapshot = queue.snapshot();
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.items[0].status, QUEUE_STATES.waiting);
});

test("nextUniqueName compares case-insensitively and keeps the first name", () => {
  const used = new Set();
  assert.equal(nextUniqueName(used, "Street Van"), "Street Van");
  assert.equal(nextUniqueName(used, "street van"), "street van-2");
  assert.equal(nextUniqueName(used, "Street Van"), "Street Van-3");
  assert.equal(nextUniqueName(used, "  "), "model");
  assert.equal(nextUniqueName(used, "model"), "model-2");
});
