import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store/sqliteStore.js";

test("one device can hold several concurrent special calls", () => {
	const store = new SqliteStore(":memory:");
	store.applyCallStart("CALLER000001", 10, 1, "type3");
	store.applyCallStart("CALLER000001", 11, 1, "type4");

	const active = store.getActiveCalls();
	assert.equal(active.length, 2);
	assert.deepEqual(active.map(c => c.call_type).sort(), ["type3", "type4"]);

	// Un CALL_END del dispositivo cierra su llamada normal/emergencia: los
	// especiales del mismo llamador siguen activos.
	const { historyRecord } = store.applyCallEnd("CALLER000001", 12);
	assert.equal(historyRecord, undefined);
	assert.equal(store.getActiveCalls().length, 2);
	assert.equal(store.getActiveCallForDevice("CALLER000001"), undefined);

	// Cerrar un especial puntual no toca al resto
	const closed = store.applySpecialCallEnd("CALLER000001", "type3");
	assert.equal(closed?.state.active, false);
	assert.equal(closed?.state.call_type, "type3");
	assert.ok((closed?.historyRecord?.durationMs ?? -1) >= 0);
	assert.equal(store.getActiveCalls().length, 1);
	assert.equal(store.getActiveCalls()[0]?.call_type, "type4");

	// Un segundo cierre del mismo tipo no duplica historial
	assert.equal(store.applySpecialCallEnd("CALLER000001", "type3"), undefined);
	assert.equal(store.getCallHistory().length, 1);

	store.applySpecialCallEnd("CALLER000001", "type4");
	assert.equal(store.getActiveCalls().length, 0);
	assert.equal(store.getCallHistory().length, 2);
	store.close();
});

test("special insist reuses the same slot and keeps its start time", () => {
	const store = new SqliteStore(":memory:");
	const first = store.applyCallStart("CALLER000001", 5, 1, "type4");
	const again = store.applyCallStart("CALLER000001", 6, 2, "type4");

	assert.equal(store.getActiveCalls().length, 1);
	assert.equal(again.cons, 2);
	assert.equal(again.startedAtMs, first.startedAtMs);
	assert.equal(again.startSeq, 5);

	// Otro tipo del mismo llamador convive sin pisar el primero
	store.applyCallStart("CALLER000001", 7, 1, "type6");
	assert.equal(store.getActiveCalls().length, 2);
	store.close();
});

test("normal and special calls of the same device stay independent", () => {
	const store = new SqliteStore(":memory:");
	store.applyCallStart("CALLER000001", 1, 1, "type3");
	store.applyCallStart("CALLER000001", 2, 4, "emergency");

	const normal = store.getActiveCallForDevice("CALLER000001");
	assert.equal(normal?.call_type, "emergency");
	assert.equal(normal?.cons, 4);
	assert.equal(store.getActiveSpecialCallsForDevice("CALLER000001").length, 1);

	// Terminar la emergencia deja vivo el especial
	store.applyCallEnd("CALLER000001", 3);
	assert.equal(store.getActiveCallForDevice("CALLER000001"), undefined);
	assert.equal(store.getActiveSpecialCallsForDevice("CALLER000001").length, 1);
	store.close();
});

test("migrates legacy special rows out of active_calls on startup", () => {
	const dir = mkdtempSync(join(tmpdir(), "clinum-store-"));
	const dbPath = join(dir, "store.db");
	const created = new SqliteStore(dbPath);
	created.close();

	// BD "vieja": especial activo conviviendo en active_calls
	const legacy = new Database(dbPath);
	legacy.prepare(`
		INSERT INTO active_calls (device_id, active, cons, call_type, started_at_ms, updated_at_ms, start_seq, last_seq)
		VALUES ('CALLER000001', 1, 2, 'type5', 1000, 2000, 7, 8)
	`).run();
	legacy.prepare(`
		INSERT INTO active_calls (device_id, active, cons, call_type, started_at_ms, updated_at_ms, start_seq, last_seq)
		VALUES ('CALLER000002', 0, 0, 'type3', 3000, 4000, 9, 9)
	`).run();
	legacy.close();

	const reopened = new SqliteStore(dbPath);
	const specials = reopened.getActiveSpecialCallsForDevice("CALLER000001");
	assert.equal(specials.length, 1);
	assert.equal(specials[0]?.call_type, "type5");
	assert.equal(specials[0]?.cons, 2);
	assert.equal(specials[0]?.startSeq, 7);
	// active_calls queda limpia: solo normal/emergency
	assert.equal(reopened.getActiveCallForDevice("CALLER000001"), undefined);
	assert.equal(reopened.getCallForDevice("CALLER000002")?.call_type, "normal");
	reopened.close();

	rmSync(dir, { recursive: true, force: true });
});
