import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../src/store/sqliteStore.js";

test("presence sweep expires stale devices and lamps but keeps fresh ones online", () => {
  const store = new SqliteStore(":memory:");
  try {
    const device = store.registerDevice("CALLER000001", "AA:BB:CC:DD:EE:01", "Cama 1");
    const lamp = store.registerLamp("LAMP00000001", "AA:BB:CC:DD:EE:02");

    assert.deepEqual(store.sweepOfflineDevices(90_000, device.lastSeenMs + 89_999), []);
    assert.deepEqual(store.sweepOfflineLamps(90_000, lamp.lastSeenMs + 89_999), []);
    assert.equal(store.getDevice("CALLER000001")?.online, true);
    assert.equal(store.getLamp("LAMP00000001")?.online, true);

    assert.deepEqual(store.sweepOfflineDevices(90_000, device.lastSeenMs + 90_001), ["CALLER000001"]);
    assert.deepEqual(store.sweepOfflineLamps(90_000, lamp.lastSeenMs + 90_001), ["LAMP00000001"]);
    assert.equal(store.getDevice("CALLER000001")?.online, false);
    assert.equal(store.getLamp("LAMP00000001")?.online, false);

    store.touchDevice("CALLER000001");
    store.touchLamp("LAMP00000001");
    assert.equal(store.getDevice("CALLER000001")?.online, true);
    assert.equal(store.getLamp("LAMP00000001")?.online, true);
  } finally {
    store.close();
  }
});
