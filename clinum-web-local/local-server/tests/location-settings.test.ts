import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../src/store/sqliteStore.js";

test("allows short pending reminder intervals", () => {
  const store = new SqliteStore(":memory:");
  assert.equal(store.updateLocationSettings({ pendingReminderIntervalS: 10 }).pendingReminderIntervalS, 10);
  assert.equal(store.updateLocationSettings({ pendingReminderIntervalS: 20 }).pendingReminderIntervalS, 20);
  assert.equal(store.updateLocationSettings({ pendingReminderIntervalS: 5 }).pendingReminderIntervalS, 10);
  assert.equal(store.updateLocationSettings({ pendingReminderIntervalS: 1000 }).pendingReminderIntervalS, 900);
  store.close();
});
