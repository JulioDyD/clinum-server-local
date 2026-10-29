import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteStore } from "../src/store/sqliteStore.js";

test("allows short pending reminder intervals", () => {
  const store = new SqliteStore(":memory:");
  assert.equal(store.updateLocationSettings({ pendingReminderIntervalS: 5 }).pendingReminderIntervalS, 5);
  assert.equal(store.updateLocationSettings({ pendingReminderIntervalS: 10 }).pendingReminderIntervalS, 10);
  assert.equal(store.updateLocationSettings({ pendingReminderIntervalS: 20 }).pendingReminderIntervalS, 20);
  assert.equal(store.updateLocationSettings({ pendingReminderIntervalS: 4 }).pendingReminderIntervalS, 5);
  assert.equal(store.updateLocationSettings({ pendingReminderIntervalS: 1000 }).pendingReminderIntervalS, 900);
  store.close();
});

test("defaults the normal call color to the timer green", () => {
  const store = new SqliteStore(":memory:");
  try {
    const settings = store.getLocationSettings();
    assert.equal(settings.normalCallColor, "#22c55e");
    assert.equal(settings.normalCallColor, settings.timerColor);
  } finally {
    store.close();
  }
});

test("migrates the legacy normal call color once and keeps later choices", () => {
  const dir = mkdtempSync(join(tmpdir(), "clinum-color-"));
  const file = join(dir, "clinum.db");
  try {
    const store = new SqliteStore(file);
    store.close();

    const raw = new Database(file);
    raw.prepare("DELETE FROM schema_migrations WHERE name = 'normal_call_color_green'").run();
    raw.prepare("UPDATE location_settings SET normal_call_color = '#0ea5e9' WHERE id = 1").run();
    raw.close();

    const migrated = new SqliteStore(file);
    assert.equal(migrated.getLocationSettings().normalCallColor, "#22c55e");
    migrated.updateLocationSettings({ normalCallColor: "#0ea5e9" });
    migrated.close();

    const reopened = new SqliteStore(file);
    assert.equal(reopened.getLocationSettings().normalCallColor, "#0ea5e9");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clamps the location screen scale between 50 and 200 percent", () => {
  const store = new SqliteStore(":memory:");
  try {
    assert.equal(store.getLocationSettings().uiScalePercent, 100);
    assert.equal(store.updateLocationSettings({ uiScalePercent: 120 }).uiScalePercent, 120);
    assert.equal(store.updateLocationSettings({ uiScalePercent: 200 }).uiScalePercent, 200);
    assert.equal(store.updateLocationSettings({ uiScalePercent: 20 }).uiScalePercent, 50);
    assert.equal(store.updateLocationSettings({ uiScalePercent: 250 }).uiScalePercent, 200);
  } finally {
    store.close();
  }
});
