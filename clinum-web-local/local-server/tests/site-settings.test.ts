import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store/sqliteStore.js";

test("online window defaults to 90 seconds and is clamped between 60 and 600", () => {
  const store = new SqliteStore(":memory:");
  try {
    assert.equal(store.getSiteSettings().onlineWindowS, 90);
    assert.equal(store.getOnlineWindowMs(), 90_000);

    assert.equal(store.updateSiteSettings({ onlineWindowS: 120 }).onlineWindowS, 120);
    assert.equal(store.getOnlineWindowMs(), 120_000);

    assert.equal(store.updateSiteSettings({ onlineWindowS: 10 }).onlineWindowS, 60);
    assert.equal(store.updateSiteSettings({ onlineWindowS: 9000 }).onlineWindowS, 600);
    assert.equal(store.updateSiteSettings({ onlineWindowS: Number.NaN }).onlineWindowS, 600);
  } finally {
    store.close();
  }
});

test("online window persists across reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "clinum-site-settings-"));
  const file = join(dir, "clinum.db");
  try {
    const store = new SqliteStore(file);
    store.updateSiteSettings({ onlineWindowS: 150 });
    store.close();

    const reopened = new SqliteStore(file);
    assert.equal(reopened.getSiteSettings().onlineWindowS, 150);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
