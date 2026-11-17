import test from "node:test";
import assert from "node:assert/strict";
import "../chrome-extension/library-filter.js";

const {
  filterLibraryEntries,
  libraryEntryDate,
  librarySearchText,
} = globalThis.MeshportLibraryFilter;

const entries = [
  { key: "street", name: "Street Van", createdAt: "2026-11-15T10:00:00.000Z" },
  { key: "survivor", name: "Survivor", createdAt: "2026-11-10T10:00:00.000Z" },
  { key: "cafe", name: "Café Chair", createdAt: "2026-11-12T10:00:00.000Z" },
  { key: "mesh", name: "Meshy Axe", capturedAt: 1763200000000 },
];

const keys = (list) => list.map((entry) => entry.key);

test("search is case-insensitive and ignores surrounding spaces", () => {
  assert.deepEqual(keys(filterLibraryEntries(entries, { query: "  street  " })), ["street"]);
  assert.deepEqual(keys(filterLibraryEntries(entries, { query: "AXE" })), ["mesh"]);
});

test("search treats accents and plain letters as the same", () => {
  assert.deepEqual(keys(filterLibraryEntries(entries, { query: "cafe" })), ["cafe"]);
  assert.deepEqual(keys(filterLibraryEntries(entries, { query: "CAFÉ" })), ["cafe"]);
});

test("an empty query returns every entry, newest first", () => {
  assert.deepEqual(
    keys(filterLibraryEntries(entries)),
    ["street", "cafe", "survivor", "mesh"],
  );
});

test("date sort understands ISO strings, seconds and milliseconds", () => {
  assert.equal(libraryEntryDate({ createdAt: "2026-11-15T10:00:00.000Z" }), Date.parse("2026-11-15T10:00:00.000Z"));
  assert.equal(libraryEntryDate({ createdAt: 1763200000 }), 1763200000000);
  assert.equal(libraryEntryDate({ createdAt: 1763200000000 }), 1763200000000);
  assert.equal(libraryEntryDate({ createdAt: "1763200000000" }), 1763200000000);
  assert.equal(libraryEntryDate({ createdAt: "1763200000" }), 1763200000000);
  assert.equal(libraryEntryDate({}), 0);
  assert.equal(libraryEntryDate(null), 0);
});

test("entries without a date land after dated entries, keeping their order", () => {
  const mixed = [
    { key: "none-a" },
    { key: "dated", createdAt: "2026-11-15T10:00:00.000Z" },
    { key: "none-b" },
  ];
  assert.deepEqual(keys(filterLibraryEntries(mixed)), ["dated", "none-a", "none-b"]);
});

test("name sort is natural and case-insensitive", () => {
  const named = [
    { key: "ten", name: "Model 10" },
    { key: "two", name: "model 2" },
    { key: "one", name: "Model 1" },
  ];
  assert.deepEqual(keys(filterLibraryEntries(named, { sort: "name" })), ["one", "two", "ten"]);
});

test("titleOf supplies the text used by search and sort", () => {
  const bare = [
    { key: "b", projectId: "bbbbbbbb-0000" },
    { key: "a", projectId: "aaaaaaaa-0000" },
  ];
  const titleOf = (entry) => `Project ${entry.projectId}`;
  assert.deepEqual(keys(filterLibraryEntries(bare, { sort: "name", titleOf })), ["a", "b"]);
  assert.deepEqual(keys(filterLibraryEntries(bare, { query: "aaaa", titleOf })), ["a"]);
});

test("filtering never mutates the caller's array", () => {
  const original = entries.slice();
  filterLibraryEntries(entries, { query: "street" });
  filterLibraryEntries(entries, { sort: "name" });
  assert.deepEqual(entries, original);
});

test("search text normalizes to lowercase without accents", () => {
  assert.equal(librarySearchText("  Café  "), "cafe");
  assert.equal(librarySearchText(null), "");
});
