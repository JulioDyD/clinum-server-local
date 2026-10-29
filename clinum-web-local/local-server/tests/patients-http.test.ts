import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { compile } from "@vue/compiler-dom";
import { SqliteStore } from "../src/store/sqliteStore.js";

test("patient HTML templates compile and their scripts are valid JavaScript", () => {
  for (const file of ["index.html", "location.html"]) {
    const html = readFileSync(resolve("public", file), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    if (file === "index.html") {
      assert.match(html, /v-show="tab === 'patients'"/);
      assert.match(html, /info-pill-mac/);
      assert.match(html, /<option :value="10">10 segundos<\/option>/);
      assert.match(html, /<option :value="20">20 segundos<\/option>/);
      assert.match(html, /Firmware <strong class="info-mono">/);
      assert.match(script, /socket\.on\('patient_list'/);
      assert.match(script, /const patientRequest/);
      assert.match(script, /const gatewayInfo/);
      assert.match(script, /const gatewayMacLabel/);
      assert.match(script, /const gatewayFirmwareLabel/);
      assert.match(script, /socket\.on\('device_presence'/);
      assert.match(script, /T\?HLN\|T\?VLN/);
    }
    new Function(script);
    const start = html.indexOf('<div id="app"');
    assert.ok(start >= 0);
    compile(html.slice(start, html.indexOf("<script>", start)), { onError: error => { throw error; } });
  }
});

test("patient REST CRUD updates call names and preserves clinical state", { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "clinum-http-"));
  const db = join(dir, "test.db");
  const store = new SqliteStore(db);
  store.registerDevice("CALLER000001", "", "Cama 1");
  store.applyCallStart("CALLER000001", 1, 2, "emergency");
  store.close();
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    env: { ...process.env, SERIAL_PORT: "none", LOCAL_ONLY: "1", LOCAL_DB_FILE: db, LOCAL_HTTP_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + path, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any };
  };
  try {
    let ready = false;
    for (let i = 0; i < 600; i++) {
      try { ready = (await request("/health")).status === 200; } catch { /* wait for bootstrap */ }
      if (ready || child.exitCode !== null) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, logs);
    assert.equal((await request("/patients", "POST", { name: "", age: 12 })).status, 400);
    const created = await request("/patients", "POST", { name: "José, Pérez", age: 30, notes: "Revisión mañana", assignedDevice: "CALLER000001" });
    assert.equal(created.status, 201);
    assert.equal(created.data.deliveryPending, true);
    const id = created.data.patientId;
    assert.equal((await request("/calls/active")).data.items[0].patientName, "José, Pérez");
    assert.equal((await request(`/patients/${id}`, "PATCH", { name: "Ana" })).status, 200);
    assert.equal((await request("/calls/active")).data.items[0].cons, 2);
    assert.equal((await request("/calls/active")).data.items[0].call_type, "emergency");
    assert.equal((await request(`/patients/${id}/sync`, "POST")).status, 200);
    assert.equal((await request(`/patients/${id}`, "PATCH", { assignedDevice: null })).status, 200);
    assert.equal((await request("/calls/active")).data.items[0].patientName, undefined);
    assert.equal((await request(`/patients/${id}`, "DELETE")).status, 200);
    assert.equal((await request(`/patients/${id}`)).status, 404);
    assert.equal((await request("/patients")).data.items.length, 0);
    assert.equal((await request("/devices")).data.items[0].name, "Cama 1");
    assert.equal((await request("/devices/CALLER000001", "PATCH", { name: "a".repeat(33) })).status, 400);
    assert.equal((await request("/devices/CALLER000001", "PATCH", { name: "Cama nueva" })).status, 200);
    let diagnostics = (await request("/network/diagnostics")).data;
    assert.ok(diagnostics.pendingCommands.some((c: any) => c.kind === "name" && c.payload.name === "Cama nueva"));
    assert.equal((await request("/calls/CALLER000001/end", "POST")).status, 200);
    diagnostics = (await request("/network/diagnostics")).data;
    assert.ok(diagnostics.pendingCommands.some((c: any) => c.kind === "end" && c.payload.targetCallSeq === 1));
    assert.equal((await request("/calls/active")).data.items.length, 0);
  } finally {
    const exited = new Promise(resolve => child.once("exit", resolve));
    if (child.exitCode === null) { child.kill(); await exited; }
    rmSync(dir, { recursive: true, force: true });
  }
});
