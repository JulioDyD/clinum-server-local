import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SqliteStore } from "../src/store/sqliteStore.js";

test("server emits a detection event when a presence session opens", () => {
  const source = readFileSync(resolve("src", "index.ts"), "utf8");
  assert.match(source, /publishPresenceDetection/);
  assert.match(source, /hub\.publishPresenceDetection\(\{ deviceId, areaName: sensor\.areaName, role: sensor\.role \}\)/);
});

test("presence detection is emitted on every false->true transition", () => {
  const source = readFileSync(resolve("src", "index.ts"), "utf8");
  assert.match(source, /const wasPresent = runtime\.present/);
  assert.match(source, /if \(!wasPresent\) hub\.publishPresenceDetection/);
  assert.match(source, /runtime\.present = false/);
});

test("presence settings default disabled with expected thresholds", () => {
  const store = new SqliteStore(":memory:");
  try {
    const settings = store.getPresenceSettings();
    assert.equal(settings.enabled, false);
    assert.equal(settings.showOnLocation, false);
    assert.equal(settings.showFreeOnLocation, true);
    assert.equal(settings.exitGraceS, 0);
    assert.equal(settings.minSessionS, 0);
    assert.equal(settings.staleS, 180);
    assert.equal(settings.longStayMin, 15);
    assert.equal(settings.alertEnabled, true);
    assert.equal(settings.soundOnDetection, false);
    assert.equal(settings.detectionSound, "alert.mp3");
  } finally {
    store.close();
  }
});

test("presence sensors can be assigned and are removed with the device", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.registerDevice("CALLER000001", "", "Cama 1");
    const sensor = store.upsertPresenceSensor("CALLER000001", "bathroom", "Baño 1");
    assert.equal(sensor.role, "bathroom");
    assert.equal(sensor.areaName, "Baño 1");
    assert.equal(store.getPresenceSensors().length, 1);

    store.deleteDevice("CALLER000001");
    assert.equal(store.getPresenceSensors().length, 0);
  } finally {
    store.close();
  }
});

test("presence roles accept bathroom, sillon and cama (legacy bed maps to cama)", () => {
  const store = new SqliteStore(":memory:");
  try {
    assert.equal(store.upsertPresenceSensor("A", "sillon", "Sillón 1").role, "sillon");
    assert.equal(store.upsertPresenceSensor("B", "cama", "Cama 101").role, "cama");
    assert.equal(store.upsertPresenceSensor("C", "bed" as never, "Cama 102").role, "cama");
  } finally {
    store.close();
  }
});

test("presence sessions open, close, ignore short ones and filter correctly", () => {
  const store = new SqliteStore(":memory:");
  try {
    const opened = store.openPresenceSession("CALLER000001", "bathroom", "Baño 1", 1000, 1000);
    assert.equal(opened.exitedAtMs, undefined);
    store.touchPresenceSession(opened.id, 5000);

    const closed = store.closePresenceSession(opened.id, 13000, "sensor");
    assert.equal(closed?.durationMs, 12000);
    assert.equal(closed?.closeReason, "sensor");
    assert.equal(store.getOpenPresenceSessions().length, 0);
    assert.equal(store.getPresenceSessions({ deviceId: "CALLER000001" }).length, 1);
    assert.equal(store.getPresenceSessions({ openOnly: true }).length, 0);

    const short = store.openPresenceSession("CALLER000001", "bathroom", "Baño 1", 20000, 20000);
    assert.equal(store.closePresenceSession(short.id, 23000, "sensor", 5000), undefined);
    assert.equal(store.getPresenceSessions({ deviceId: "CALLER000001" }).length, 1);
  } finally {
    store.close();
  }
});

test("open presence sessions are closed on server restart", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.openPresenceSession("CALLER000001", "bathroom", "Baño 1", 1000, 1000);
    store.openPresenceSession("CALLER000002", "bathroom", "Baño 2", 2000, 2000);
    assert.equal(store.closeAllOpenPresenceSessions("server_restart", 5000), 2);
    assert.equal(store.getOpenPresenceSessions().length, 0);
  } finally {
    store.close();
  }
});
