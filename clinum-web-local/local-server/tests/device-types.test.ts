import assert from "node:assert/strict";
import test from "node:test";
import { isTactileFirmware } from "../src/deviceTypes.js";

test("classifies tactile firmware prefixes including the T variant", () => {
  for (const version of ["HLN-11.1", "VLN-11.1", "THLN-11.1", "TVLN-11.1", "thln-11.1", " TVLN-11.1 "]) {
    assert.equal(isTactileFirmware(version), true, version);
  }
  for (const version of ["CLN-11.1", "CLN-9", "RPT-1.0", "", "   ", undefined, null]) {
    assert.equal(isTactileFirmware(version), false, String(version));
  }
});
