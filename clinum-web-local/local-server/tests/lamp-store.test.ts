import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../src/store/sqliteStore.js";

test("persists lamp settings and replaces caller assignments", () => {
	const store = new SqliteStore(":memory:");
	store.registerLamp("LAMP00000001", "AA:BB:CC:DD:EE:01", true, 1);
	store.registerLamp("LAMP00000002", "AA:BB:CC:DD:EE:02", true, 1);

	assert.deepEqual(store.setLampAssignments("CALLER000001", ["LAMP00000002", "LAMP00000001", "LAMP00000001"]), [
		"LAMP00000001",
		"LAMP00000002",
	]);
	assert.deepEqual(store.setLampAssignments("CALLER000001", ["LAMP00000002"]), ["LAMP00000002"]);

	const updated = store.updateLamp("LAMP00000002", { name: "Pasillo norte", audioEnabled: false, brightness: 73, buzzerVolume: 40 });
	assert.equal(updated?.name, "Pasillo norte");
	assert.equal(updated?.audioEnabled, false);
	assert.equal(updated?.brightness, 73);
	assert.equal(updated?.buzzerVolume, 40);
	store.close();
});

test("aggregates assigned active calls by clinical priority", () => {
	const store = new SqliteStore(":memory:");
	store.registerLamp("LAMP00000001", "AA:BB:CC:DD:EE:01");
	store.setLampAssignments("CALLER000001", ["LAMP00000001"]);
	store.setLampAssignments("CALLER000002", ["LAMP00000001"]);

	assert.equal(store.getEffectiveLampState("LAMP00000001"), "off");
	store.applyCallStart("CALLER000001", 1, 1, "normal");
	assert.equal(store.getEffectiveLampState("LAMP00000001"), "normal");
	store.applyCallStart("CALLER000002", 1, 1, "emergency");
	assert.equal(store.getEffectiveLampState("LAMP00000001"), "emergency");
	store.applyCallEnd("CALLER000002", 2);
	assert.equal(store.getEffectiveLampState("LAMP00000001"), "normal");
	store.applyCallEnd("CALLER000001", 2);
	assert.equal(store.getEffectiveLampState("LAMP00000001"), "off");
	store.close();
});

test("seeds five bounded alert profiles", () => {
	const store = new SqliteStore(":memory:");
	assert.equal(store.getLampAlertProfiles().length, 5);
	assert.equal(store.getLampAlertProfile("normal")?.enabled, true);
	assert.equal(store.getLampAlertProfile("emergency")?.enabled, true);
	const updated = store.updateLampAlertProfile("normal", { colorPreset: 99, soundPreset: -4, audioEnabled: false });
	assert.equal(updated?.colorPreset, 19);
	assert.equal(updated?.soundPreset, 0);
	assert.equal(updated?.audioEnabled, false);
	store.close();
});
