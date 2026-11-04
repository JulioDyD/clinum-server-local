import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const readPackaging = (name: string) => readFileSync(resolve("packaging", name), "utf8");

test("site install/update fetch only the app subtree, never firmware", () => {
  const lib = readPackaging("lib.sh");
  assert.match(lib, /fetch_app_source\(\)/);
  assert.match(lib, /--filter=blob:none/);
  assert.match(lib, /--sparse/);
  assert.match(lib, /FETCHED_SRC=/);
  for (const script of ["site-install.sh", "site-update.sh"]) {
    const text = readPackaging(script);
    assert.match(text, /fetch_app_source "\$REPO" "\$REF" "\$SRC"/);
    assert.match(text, /SRC="\$FETCHED_SRC"/);
    assert.doesNotMatch(text, /git clone/);
  }
});

test("deb packaging copies only app artifacts", () => {
  const text = readPackaging("build-deb.sh");
  assert.match(text, /cp -r "\$APP_DIR\/dist"/);
  assert.match(text, /cp -r "\$APP_DIR\/public"/);
  assert.doesNotMatch(text, /alert-lamp|call-lcd|gatenway|gateway-esp32|lora_transport/);
});

test("official updater is installed on the site", () => {
  const build = readPackaging("build-deb.sh");
  assert.match(build, /cp -f "\$APP_DIR\/packaging\/site-update\.sh"/);
  assert.match(build, /cp -f "\$APP_DIR\/packaging\/lib\.sh"/);
  assert.match(build, /clinum-update/);

  const wrapper = readFileSync(resolve("packaging/deb-root/usr/local/bin/clinum-update"), "utf8");
  assert.match(wrapper, /\/opt\/clinum-web-local\/packaging\/site-update\.sh/);
  assert.match(wrapper, /id -u/);
});

test("site assignment is GUI-only (no --location-id in install/update)", () => {
  for (const script of ["site-install.sh", "site-update.sh"]) {
    assert.doesNotMatch(readPackaging(script), /--location-id/);
  }
  assert.match(readPackaging("lib.sh"), /verify_credential\(\)/);
});

test("Firebase credentials are provisioned atomically and injected by systemd", () => {
  const lib = readPackaging("lib.sh");
  assert.match(lib, /validate_service_account\(\)/);
  assert.match(lib, /install_service_account_atomic\(\)/);
  assert.match(lib, /LoadCredential=firebase:/);
  assert.match(lib, /chmod 0600/);
  assert.match(lib, /service-account\.json/);

  for (const script of ["site-install.sh", "site-update.sh"]) {
    const text = readPackaging(script);
    assert.match(text, /--service-account-file/);
    assert.match(text, /--service-account-stdin/);
    assert.match(text, /validate_service_account/);
    assert.match(text, /enable_systemd_credential/);
  }

  const run = readFileSync(resolve("packaging/deb-root/opt/clinum-web-local/run.sh"), "utf8");
  assert.match(run, /CREDENTIALS_DIRECTORY/);
  assert.match(run, /GOOGLE_APPLICATION_CREDENTIALS/);

  const unit = readFileSync(resolve("packaging/deb-root/usr/lib/systemd/system/clinum-web-local.service"), "utf8");
  assert.match(unit, /ExecStart=\/opt\/clinum-web-local\/run\.sh/);

  const postinst = readFileSync(resolve("packaging/deb-root/DEBIAN/postinst"), "utf8");
  assert.match(postinst, /LoadCredential=firebase:/);
  assert.match(postinst, /chmod 0600/);
});
