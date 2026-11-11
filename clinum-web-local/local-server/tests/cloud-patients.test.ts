import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../src/store/sqliteStore.js";

test("cloud patients are mirrored and keep one-to-one device assignment", () => {
  const store = new SqliteStore(":memory:");
  try {
    const first = store.upsertCloudPatient({
      patientId: "P1",
      name: "Maria",
      age: 80,
      assignedDevice: "DEV1",
      updatedAtMs: 1000,
    });
    assert.equal(first.previousDevice, null);
    assert.equal(first.patient.source, "cloud");
    assert.equal(store.getPatientByDevice("DEV1")?.patientId, "P1");

    const second = store.upsertCloudPatient({
      patientId: "P2",
      name: "Jose",
      assignedDevice: "DEV1",
      updatedAtMs: 2000,
    });
    assert.equal(store.getPatientByDevice("DEV1")?.patientId, "P2");
    assert.equal(store.getPatient("P1")?.assignedDevice, null);
    assert.equal(second.previousDevice, null);

    const moved = store.upsertCloudPatient({
      patientId: "P2",
      name: "Jose",
      assignedDevice: "DEV2",
      updatedAtMs: 3000,
    });
    assert.equal(moved.previousDevice, "DEV1");
    assert.equal(store.getPatientByDevice("DEV2")?.patientId, "P2");
  } finally {
    store.close();
  }
});

test("reconcile removes only cloud-mirrored patients", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.registerDevice("DEV9", "AA:BB:CC:DD:EE:99");
    const local = store.createPatient({ name: "Local", assignedDevice: "DEV9" });
    store.upsertCloudPatient({ patientId: "C1", name: "Cloud 1", assignedDevice: "DEV1" });
    store.upsertCloudPatient({ patientId: "C2", name: "Cloud 2", assignedDevice: "DEV2" });

    const removed = store.deleteCloudPatientsNotIn(["C1"]);
    assert.deepEqual(removed.map(patient => patient.patientId), ["C2"]);
    assert.ok(store.getPatient("C1"));
    assert.equal(store.getPatient("C2"), undefined);
    assert.ok(store.getPatient(local.patientId));
    assert.equal(store.getPatient(local.patientId)?.source, "local");
  } finally {
    store.close();
  }
});
