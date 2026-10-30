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
