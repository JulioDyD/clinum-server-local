import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../src/store/sqliteStore.js";

test("deleting a device clears its pending commands and clearing removes the rest", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.registerDevice("CALLER000001", "", "Cama 1");
    store.registerDevice("CALLER000002", "", "Cama 2");
    store.savePendingCommand("CALLER000001", "end", 1, { endCall: true, targetCallSeq: 1 });
    store.savePendingCommand("CALLER000001", "name", 2, { name: "Nuevo" });
    store.savePendingCommand("CALLER000002", "end", 3, { endCall: true, targetCallSeq: 2 });
    assert.equal(store.getPendingCommands().length, 3);

    assert.equal(store.deleteDevice("CALLER000001"), true);
    assert.deepEqual(store.getPendingCommands().map(c => c.deviceId), ["CALLER000002"]);

    assert.equal(store.clearPendingCommands(), 1);
    assert.deepEqual(store.getPendingCommands(), []);
    assert.equal(store.clearPendingCommands(), 0);
  } finally {
    store.close();
  }
});
