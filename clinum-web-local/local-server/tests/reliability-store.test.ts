import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../src/store/sqliteStore.js";
import type { IncomingFrame } from "../src/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("receipt distinguishes acknowledged duplicate from never-applied stale event", () => {
  const store = new SqliteStore(":memory:");
  try {
    const event: IncomingFrame = { msgType: "call_start", deviceId: "CALLER000001", seq: 10, sentAtMs: 0, cons: 1 };
    const apply = () => store.applyCallStart(event.deviceId, event.seq, 1, "normal");
    assert.equal(store.receiveCallEvent(event, apply).result, "ok");
    assert.equal(store.receiveCallEvent(event, apply).result, "duplicate");
    assert.equal(store.receiveCallEvent({ ...event, seq: 9 }, apply).result, "stale");
    assert.equal(store.receiveCallEvent({ ...event, cons: 3 }, apply).result, "invalid");
    assert.equal(store.getActiveCalls()[0].cons, 1);
  } finally { store.close(); }
});

test("failed state mutation rolls back receipt and sequence together", () => {
  const store = new SqliteStore(":memory:");
  try {
    const event: IncomingFrame = { msgType: "call_start", deviceId: "CALLER000001", seq: 10, sentAtMs: 0 };
    assert.throws(() => store.receiveCallEvent(event, () => {
      store.applyCallStart(event.deviceId, event.seq, 1, "normal");
      throw new Error("simulated failure before commit");
    }));
    assert.equal(store.getActiveCalls().length, 0);
    assert.equal(store.isDuplicateOrOld(event.deviceId, event.seq), false);
    assert.equal(store.receiveCallEvent(event, () => store.applyCallStart(event.deviceId, event.seq, 1, "normal")).result, "ok");
  } finally { store.close(); }
});

test("remote commands require matching acknowledgement", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.savePendingCommand("CALLER000001", "end", 123, { endCall: true, targetCallSeq: 10 });
    store.confirmPendingCommand("CALLER000001", 124);
    assert.equal(store.getPendingCommands().length, 1);
    store.markCommandSent("CALLER000001", "end");
    assert.equal(store.getPendingCommands()[0].attempts, 1);
    store.confirmPendingCommand("CALLER000001", 123);
    assert.equal(store.getPendingCommands().length, 0);
  } finally { store.close(); }
});

test("power cycle preserves exact receipts, clinical state and remote commands", () => {
  const dir = mkdtempSync(join(tmpdir(), "clinum-reliable-"));
  const file = join(dir, "state.db");
  const event: IncomingFrame = { deviceId: "CALLER000001", msgType: "call_start", seq: 100, callId: 100, call_type: "emergency", cons: 1, sentAtMs: 0 };
  try {
    let store = new SqliteStore(file);
    store.receiveCallEvent(event, () => store.applyCallStart(event.deviceId, event.seq, 1, "emergency"));
    store.transaction(() => {
      store.forceEndCall(event.deviceId);
      store.savePendingCommand(event.deviceId, "end", 900, { endCall: true, targetCallSeq: 100 });
    });
    store.close();
    store = new SqliteStore(file);
    try {
      assert.equal(store.receiveCallEvent(event, () => { throw new Error("duplicate must not apply"); }).result, "duplicate");
      assert.equal(store.getActiveCalls().length, 0);
      assert.equal(store.getPendingCommands()[0].payload.targetCallSeq, 100);
      assert.equal(store.getCallHistory().length, 1);
      store.confirmPendingCommand(event.deviceId, 900);
      const sequence = store.nextCommandSeq();
      assert.equal(store.nextCommandSeq(), sequence + 1);
    } finally { store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delayed closure of an older call cannot close the new call; emergency upgrade retains identity", () => {
  const store = new SqliteStore(":memory:");
  try {
    const event: IncomingFrame = { deviceId: "CALLER000001", msgType: "call_start", seq: 10, callId: 10, call_type: "normal", cons: 1, sentAtMs: 0 };
    assert.equal(store.receiveCallEvent(event, () => store.applyCallStart(event.deviceId, 10, 1, "normal")).result, "ok");
    assert.equal(store.receiveCallEvent({ ...event, seq: 11, call_type: "emergency" }, () => store.applyCallStart(event.deviceId, 11, 1, "emergency")).result, "ok");
    assert.equal(store.getActiveCalls()[0].startSeq, 10);
    store.forceEndCall(event.deviceId);
    assert.equal(store.receiveCallEvent({ ...event, seq: 20, callId: 20 }, () => store.applyCallStart(event.deviceId, 20, 1, "normal")).result, "ok");
    assert.equal(store.receiveCallEvent({ ...event, msgType: "call_end", seq: 30, callId: 10 }, () => store.applyCallEnd(event.deviceId, 30)).result, "stale");
    assert.equal(store.getActiveCalls()[0].startSeq, 20);
  } finally { store.close(); }
});

test("50 devices and burst duplicate/retry traffic apply each event only once", () => {
  const store = new SqliteStore(":memory:");
  try {
    for (let i = 0; i < 50; i++) {
      const deviceId = `CALLER${String(i).padStart(6, "0")}`;
      store.registerDevice(deviceId, "", `Cama ${i}`);
      const start: IncomingFrame = { deviceId, msgType: "call_start", seq: 100, callId: 100, sentAtMs: 0, cons: 1 };
      assert.equal(store.receiveCallEvent(start, () => store.applyCallStart(deviceId, 100, 1, "normal")).result, "ok");
      for (let retry = 0; retry < 5; retry++) assert.equal(store.receiveCallEvent(start, () => { throw new Error("duplicate"); }).result, "duplicate");
    }
    assert.equal(store.getActiveCalls().length, 50);
    for (const state of store.getActiveCalls()) {
      const end: IncomingFrame = { deviceId: state.deviceId, msgType: "call_end", seq: 101, callId: 100, sentAtMs: 0 };
      assert.equal(store.receiveCallEvent(end, () => store.applyCallEnd(state.deviceId, 101)).result, "ok");
      assert.equal(store.receiveCallEvent(end, () => { throw new Error("duplicate end"); }).result, "duplicate");
    }
    assert.equal(store.getActiveCalls().length, 0);
    assert.equal(store.getCallHistory().length, 50);
    assert.equal(store.getReliabilityCounters().committed, 100);
  } finally { store.close(); }
});
