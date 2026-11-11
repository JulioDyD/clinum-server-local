import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store/sqliteStore.js";

test("called outbox coalesces by document id and keeps history entries", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.enqueueCloudWrite("called", "CALLER1", { active: true, startedAtMs: 1000 }, ["endedAt"]);
    store.enqueueCloudWrite("called", "CALLER1", { active: false, startedAtMs: 1000, endedAtMs: 2000 }, []);
    store.enqueueCloudWrite("history", "CALLER1_1000", { endedAtMs: 2000 });
    store.enqueueCloudWrite("history", "CALLER1_1000", { endedAtMs: 2500 });

    const items = store.getDueCloudWrites(10);
    assert.equal(items.length, 2);

    const called = items.find(item => item.kind === "called");
    assert.equal(called?.docId, "CALLER1");
    assert.equal(called?.payload.active, false);
    assert.equal(called?.payload.endedAtMs, 2000);
    assert.deepEqual(called?.deleteFields, []);

    const history = items.find(item => item.kind === "history");
    assert.equal(history?.payload.endedAtMs, 2500);
    assert.equal(store.getCloudOutboxStats().pending, 2);
  } finally {
    store.close();
  }
});

test("outbox retries with backoff and can be cleared", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.enqueueCloudWrite("device", "DEV1", { isOnline: true }, []);
    const [item] = store.getDueCloudWrites(10);
    assert.ok(item);
    assert.equal(store.getDueCloudWrites(10, Date.now() + 1).length, 1);

    store.markCloudWriteFailed(item.id, 1, 10_000);
    assert.equal(store.getDueCloudWrites(1, 10_000).length, 0);
    assert.equal(store.getDueCloudWrites(1, 10_000 + 1000).length, 1);

    const [retry] = store.getDueCloudWrites(1, 10_000 + 1000);
    store.markCloudWriteDone(retry.id);
    assert.equal(store.getCloudOutboxStats().pending, 0);

    store.enqueueCloudWrite("called", "CALLER2", { active: true }, []);
    assert.equal(store.clearCloudOutbox(), 1);
    assert.equal(store.getCloudOutboxStats().pending, 0);
  } finally {
    store.close();
  }
});

test("outbox persists pending writes across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "clinum-outbox-"));
  const file = join(dir, "clinum.db");
  try {
    const store = new SqliteStore(file);
    store.enqueueCloudWrite("history", "CALLER3_1000", { endedAtMs: 2000 });
    store.close();

    const reopened = new SqliteStore(file);
    const [item] = reopened.getDueCloudWrites(10);
    assert.equal(item?.kind, "history");
    assert.equal(item?.docId, "CALLER3_1000");
    assert.equal(item?.payload.endedAtMs, 2000);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
