import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SqliteStore } from "../src/store/sqliteStore.js";

test("patient reassignment is atomic, one-to-one, and does not change calls or lamps", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.registerDevice("CALLER000001", ""); store.registerDevice("CALLER000002", "");
    store.registerLamp("LAMP00000001", ""); store.setLampAssignments("CALLER000001", ["LAMP00000001"]);
    store.applyCallStart("CALLER000001", 1, 1, "emergency");
    const a = store.createPatient({ name: "José Pérez", age: 0, notes: "Alergia, revisión\nmañana", assignedDevice: "CALLER000001" });
    const b = store.createPatient({ name: "Ana", assignedDevice: "CALLER000002" });
    assert.match(a.patientId, /^[0-9a-f-]{36}$/);
    assert.equal(store.getActiveCalls()[0].patientName, "José Pérez");
    assert.equal(store.getPatient(a.patientId)?.notes, "Alergia, revisión mañana");
    assert.throws(() => store.updatePatient(b.patientId, { assignedDevice: "CALLER000001", age: 151 }));
    assert.equal(store.getPatientByDevice("CALLER000001")?.patientId, a.patientId);
    store.updatePatient(b.patientId, { assignedDevice: "CALLER000001" });
    assert.equal(store.getPatient(a.patientId)?.assignedDevice, null);
    assert.equal(store.getPatientByDevice("CALLER000002"), undefined);
    assert.equal(store.getActiveCalls()[0].patientName, "Ana");
    assert.equal(store.getActiveCalls()[0].call_type, "emergency");
    assert.deepEqual(store.getLampIdsForCaller("CALLER000001"), ["LAMP00000001"]);
    store.updatePatient(b.patientId, { age: null, notes: null, assignedDevice: null });
    assert.equal(store.getActiveCalls()[0].patientName, undefined);
    store.updatePatient(a.patientId, { assignedDevice: "CALLER000002" });
    store.deleteDevice("CALLER000002");
    assert.equal(store.getPatient(a.patientId)?.assignedDevice, null);
    assert.equal(store.deletePatient(a.patientId), true);
    assert.equal(store.deletePatient(a.patientId), false);
  } finally { store.close(); }
});

test("patient validation rejects malformed fields without creating records", () => {
  const store = new SqliteStore(":memory:");
  try {
    for (const input of [{ name: "" }, { name: "A", age: 1.5 }, { name: "A", admissionDate: "garbage" }, { name: "A", notes: "a".repeat(121) }, { name: "A", assignedDevice: "unknown" }]) assert.throws(() => store.createPatient(input));
    assert.equal(store.getPatients().length, 0);
    const p = store.createPatient({ name: "María", admissionDate: "2026-10-01T14:35", age: 30 });
    assert.equal(store.updatePatient(p.patientId, { name: "María Gómez" })?.age, 30);
  } finally { store.close(); }
});

test("patients migrate into an existing database and persist after reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "clinum-patients-"));
  const path = join(dir, "old.db");
  try {
    const old = new Database(path);
    old.exec("CREATE TABLE devices (device_id TEXT PRIMARY KEY, mac TEXT NOT NULL DEFAULT '', name TEXT, online INTEGER DEFAULT 0, last_seen_ms INTEGER DEFAULT 0, registered_at_ms INTEGER DEFAULT 0); INSERT INTO devices(device_id,name) VALUES ('CALLER000001','Cama original');");
    old.close();
    const store = new SqliteStore(path);
    const p = store.createPatient({ name: "Paciente", assignedDevice: "CALLER000001" });
    store.close();
    const reopened = new SqliteStore(path);
    try {
      assert.equal(reopened.getPatient(p.patientId)?.assignedDevice, "CALLER000001");
      assert.equal(reopened.getDevice("CALLER000001")?.name, "Cama original");
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
