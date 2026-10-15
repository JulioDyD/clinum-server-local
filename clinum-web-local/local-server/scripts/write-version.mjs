import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));

function git(cmd) {
  try {
    return execSync(cmd, { cwd: appDir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

const commit = git("git rev-parse --short HEAD");
const branch = git("git rev-parse --abbrev-ref HEAD");
const status = git("git status --porcelain");

const info = {
  name: pkg.name,
  version: pkg.version,
  commit,
  branch,
  dirty: status !== "" && status !== "unknown",
  builtAt: new Date().toISOString(),
  node: process.version,
};

mkdirSync(join(appDir, "dist"), { recursive: true });
writeFileSync(join(appDir, "dist", "version.json"), `${JSON.stringify(info, null, 2)}\n`, "utf8");
console.log(`version.json -> v${info.version} (${info.commit} @ ${info.branch}${info.dirty ? ", dirty" : ""})`);
