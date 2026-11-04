import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIntegrationSettings } from "../src/envSettings.js";

test("runtime credential path (systemd) takes priority over the .env value", () => {
  const dir = mkdtempSync(join(tmpdir(), "clinum-env-"));
  const envPath = join(dir, ".env");
  const credPath = join(dir, "runtime-credential.json");
  writeFileSync(envPath, [
    "LOCATION_ID=test-site",
    "FIREBASE_PROJECT_ID=clinum-2",
    "LOCAL_ONLY=0",
    "GOOGLE_APPLICATION_CREDENTIALS=/no/existe/service-account.json",
    "",
  ].join("\n"));
  writeFileSync(credPath, "{}");

  const prevEnv = process.env.ENV_FILE_PATH;
  const prevCred = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  process.env.ENV_FILE_PATH = envPath;
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath;

  try {
    const settings = getIntegrationSettings();
    assert.equal(settings.envFilePath, envPath);
    assert.equal(settings.serviceAccountPath, credPath);
    assert.equal(settings.hasServiceAccount, true);
    assert.equal(settings.locationId, "test-site");
    assert.equal(settings.localOnly, false);
  } finally {
    if (prevEnv === undefined) delete process.env.ENV_FILE_PATH;
    else process.env.ENV_FILE_PATH = prevEnv;
    if (prevCred === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    else process.env.GOOGLE_APPLICATION_CREDENTIALS = prevCred;
    rmSync(dir, { recursive: true, force: true });
  }
});
