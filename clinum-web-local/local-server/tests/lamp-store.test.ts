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

test("seeds seven bounded alert profiles including special calls", () => {
	const store = new SqliteStore(":memory:");
	assert.equal(store.getLampAlertProfiles().length, 7);
	assert.equal(store.getLampAlertProfile("normal")?.enabled, true);
	assert.equal(store.getLampAlertProfile("emergency")?.enabled, true);
	for (const callType of ["type3", "type4", "type5", "type6"]) {
		assert.equal(store.getLampAlertProfile(callType)?.enabled, true);
	}
	const updated = store.updateLampAlertProfile("normal", { colorPreset: 99, soundPreset: -4, audioEnabled: false });
	assert.equal(updated?.colorPreset, 19);
	assert.equal(updated?.soundPreset, 0);
	assert.equal(updated?.audioEnabled, false);

	// Cronómetro de finalización automática (0 por defecto, acotado a 24 h)
	assert.equal(store.getLampAlertProfile("type3")?.autoEndS, 0);
	assert.equal(store.updateLampAlertProfile("type3", { autoEndS: 45 })?.autoEndS, 45);
	assert.equal(store.updateLampAlertProfile("type3", { autoEndS: -5 })?.autoEndS, 0);
	assert.equal(store.updateLampAlertProfile("type3", { autoEndS: 999_999 })?.autoEndS, 86_400);
	assert.equal(store.updateLampAlertProfile("type3", { autoEndS: 0 })?.autoEndS, 0);
	store.close();
});

test("special profiles drive only their assigned lamps with normal/emergency priority", () => {
	const store = new SqliteStore(":memory:");
	store.registerLamp("LAMP00000001", "AA:BB:CC:DD:EE:01");
	store.registerLamp("LAMP00000002", "AA:BB:CC:DD:EE:02");
	store.setLampAssignmentsForSpecialProfile("type3", ["LAMP00000001"]);
	store.setLampAssignmentsForSpecialProfile("type5", ["LAMP00000001", "LAMP00000002"]);

	assert.deepEqual(store.getLampIdsForSpecialProfile("type3"), ["LAMP00000001"]);
	assert.deepEqual(store.getLampIdsForSpecialProfile("type4"), []);
	assert.equal(store.getEffectiveLampState("LAMP00000002"), "off");

	store.applyCallStart("CALLER000009", 1, 1, "type5");
	assert.equal(store.getEffectiveLampState("LAMP00000001"), "type5");
	assert.equal(store.getEffectiveLampState("LAMP00000002"), "type5");

	store.applyCallStart("CALLER000010", 1, 1, "type3");
	assert.equal(store.getEffectiveLampState("LAMP00000001"), "type3");

	// Un llamado normal/emergencia del mismo llamador prioriza sobre los especiales
	store.setLampAssignments("CALLER000011", ["LAMP00000002"]);
	store.applyCallStart("CALLER000011", 1, 1, "normal");
	assert.equal(store.getEffectiveLampState("LAMP00000002"), "normal");
	store.applyCallStart("CALLER000012", 1, 1, "emergency");
	store.setLampAssignments("CALLER000012", ["LAMP00000002"]);
	assert.equal(store.getEffectiveLampState("LAMP00000002"), "emergency");

	store.applyCallEnd("CALLER000012", 2);
	store.applyCallEnd("CALLER000011", 2);
	assert.equal(store.getEffectiveLampState("LAMP00000002"), "type5");

	// El especial también se apaga al finalizar (cierre puntual por tipo)
	store.applySpecialCallEnd("CALLER000009", "type5");
	assert.equal(store.getEffectiveLampState("LAMP00000002"), "off");
	store.applySpecialCallEnd("CALLER000010", "type3");
	assert.equal(store.getEffectiveLampState("LAMP00000001"), "off");
	store.close();
});

test("caller registration is idempotent and preserves active state", () => {
	const store = new SqliteStore(":memory:");
	const first = store.registerDevice("CALLER000001", "00:00:00:00:01:01", "Habitacion 204");
	assert.equal(first.name, "Habitacion 204");
	store.updateDeviceName(first.deviceId, "Habitacion 101");
	store.updateDeviceLocationType(first.deviceId, "bano");
	store.applyCallStart(first.deviceId, 100, 2, "emergency");

	const repeated = store.registerDevice(first.deviceId, "00:00:00:00:01:02", "Nombre reprovisionado");
	const activeCall = store.getActiveCallForDevice(first.deviceId);

	assert.equal(repeated.registeredAtMs, first.registeredAtMs);
	assert.equal(repeated.name, "Habitacion 101");
	assert.equal(repeated.callerLocationType, "bano");
	assert.equal(repeated.mac, "00:00:00:00:01:02");
	assert.equal(activeCall?.active, true);
	assert.equal(activeCall?.call_type, "emergency");
	assert.equal(activeCall?.startSeq, 100);
	store.close();
});

test("caller registration repairs only generated placeholder names", () => {
	const store = new SqliteStore(":memory:");
	const placeholder = store.registerDevice("CALLER000002", "00:00:00:00:02:01", "Dispositivo A12F");
	const repaired = store.registerDevice(placeholder.deviceId, placeholder.mac, "Habitacion 305");
	assert.equal(repaired.name, "Habitacion 305");

	store.updateDeviceName(placeholder.deviceId, "Recepcion principal");
	const repeated = store.registerDevice(placeholder.deviceId, placeholder.mac, "Habitacion 999");
	assert.equal(repeated.name, "Recepcion principal");
	store.close();
});

test("caller registration records transport and firmware version", () => {
	const store = new SqliteStore(":memory:");
	const first = store.registerDevice("CALLER000003", "00:00:00:00:03:01", "Habitacion 401", "lora", "VLN-7.9.1");
	assert.equal(first.transport, "lora");
	assert.equal(first.firmwareVersion, "VLN-7.9.1");

	// Re-registro tras OTA: actualiza la version conservando el alta original
	const updated = store.touchDevice(first.deviceId, first.mac, "lora", "VLN-7.9.2");
	assert.equal(updated.registeredAtMs, first.registeredAtMs);
	assert.equal(updated.firmwareVersion, "VLN-7.9.2");
	assert.equal(updated.transport, "lora");

	// Un touch sin datos de red/version no pisa lo ya registrado
	const touched = store.touchDevice(first.deviceId);
	assert.equal(touched.transport, "lora");
	assert.equal(touched.firmwareVersion, "VLN-7.9.2");

	// Registro de firmware viejo (sin transporte ni version) conserva los valores
	const legacy = store.registerDevice(first.deviceId, first.mac, undefined, undefined, undefined);
	assert.equal(legacy.transport, "lora");
	assert.equal(legacy.firmwareVersion, "VLN-7.9.2");
	store.close();
});

test("lamp registration is idempotent and preserves settings", () => {
	const store = new SqliteStore(":memory:");
	const first = store.registerLamp("LAMP00000001", "AA:BB:CC:DD:EE:01", true, 2, "Pasillo 204");
	assert.equal(first.name, "Pasillo 204");
	store.updateLamp(first.lampId, { name: "Pasillo principal", brightness: 64, audioEnabled: false });

	const repeated = store.registerLamp(first.lampId, "AA:BB:CC:DD:EE:02", true, 2, "Nombre reprovisionado");

	assert.equal(repeated.registeredAtMs, first.registeredAtMs);
	assert.equal(repeated.name, "Pasillo principal");
	assert.equal(repeated.brightness, 64);
	assert.equal(repeated.audioEnabled, false);
	assert.equal(repeated.mac, "AA:BB:CC:DD:EE:02");
	store.close();
});

test("lamp transport changes after telemetry on the requested network", () => {
	const store = new SqliteStore(":memory:");
	store.registerLamp("LAMP00000001", "AA:BB:CC:DD:EE:01", true, 2, "Pasillo", "espnow");
	const requested = store.requestLampTransport("LAMP00000001", "lora");

	const touched = store.touchLamp("LAMP00000001", "", 12, "normal");

	assert.equal(requested?.transport, "espnow");
	assert.equal(touched.transport, "espnow");
	assert.equal(touched.pendingTransport, "lora");

	const confirmed = store.touchLamp("LAMP00000001", "", 13, "normal", "lora");
	assert.equal(confirmed.transport, "lora");
	assert.equal(confirmed.pendingTransport, undefined);
	assert.equal(confirmed.transportRequestedAtMs, undefined);

	store.requestLampTransport("LAMP00000001", "espnow");
	const returned = store.touchLamp("LAMP00000001", "", undefined, undefined, "espnow");
	assert.equal(returned.transport, "espnow");
	assert.equal(returned.pendingTransport, undefined);
	store.close();
});
