import fs from "node:fs";
import path from "node:path";

/** Claves de integración editables desde el panel (nunca tocamos las demás). */
const EDITABLE_KEYS = ["LOCATION_ID", "FIREBASE_PROJECT_ID", "LOCAL_ONLY"] as const;
type EditableKey = (typeof EDITABLE_KEYS)[number];

const PROD_ENV_FILE = "/etc/clinum-web-local/.env";

/** Resuelve el .env que realmente usa este proceso (dev: ./env, prod: /etc/.../.env vía systemd). */
export function resolveEnvFilePath(): string {
  if (process.env.ENV_FILE_PATH) return process.env.ENV_FILE_PATH;
  if (fs.existsSync(PROD_ENV_FILE)) return PROD_ENV_FILE;
  return path.join(process.cwd(), ".env");
}

function parseEnvLines(content: string): { lines: string[]; values: Record<string, string> } {
  const lines = content.split(/\r?\n/);
  const values: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    values[key] = trimmed.slice(eq + 1).trim();
  }
  return { lines, values };
}

export type IntegrationSettings = {
  locationId: string;
  firebaseProjectId: string;
  localOnly: boolean;
  hasServiceAccount: boolean;
  envFilePath: string;
  envFileWritable: boolean;
};

export function getIntegrationSettings(): IntegrationSettings {
  const envFilePath = resolveEnvFilePath();
  let values: Record<string, string> = {};
  let envFileWritable = false;
  try {
    const content = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, "utf8") : "";
    values = parseEnvLines(content).values;
    // Si el archivo ya existe, el permiso que importa es el del archivo (chmod del
    // grupo clinum/soporte), no el del directorio (normalmente root:root en /etc).
    const checkPath = fs.existsSync(envFilePath) ? envFilePath : path.dirname(envFilePath);
    fs.accessSync(checkPath, fs.constants.W_OK);
    envFileWritable = true;
  } catch {
    envFileWritable = false;
  }

  const credPath = values.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_APPLICATION_CREDENTIALS || "./service-account.json";
  const resolvedCredPath = path.isAbsolute(credPath) ? credPath : path.join(path.dirname(envFilePath), credPath);

  return {
    locationId: values.LOCATION_ID ?? process.env.LOCATION_ID ?? "",
    firebaseProjectId: values.FIREBASE_PROJECT_ID ?? process.env.FIREBASE_PROJECT_ID ?? "clinum-2",
    localOnly: (values.LOCAL_ONLY ?? process.env.LOCAL_ONLY ?? "1") === "1",
    hasServiceAccount: fs.existsSync(resolvedCredPath),
    envFilePath,
    envFileWritable,
  };
}

export type IntegrationSettingsInput = Partial<{
  locationId: string;
  firebaseProjectId: string;
  localOnly: boolean;
}>;

/** Actualiza solo las claves de integración en el .env real, preservando el resto del archivo. */
export function updateIntegrationSettings(input: IntegrationSettingsInput): IntegrationSettings {
  const envFilePath = resolveEnvFilePath();
  const content = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, "utf8") : "";
  const { lines } = parseEnvLines(content);

  const patch: Partial<Record<EditableKey, string>> = {};
  if (input.locationId !== undefined) patch.LOCATION_ID = String(input.locationId).trim();
  if (input.firebaseProjectId !== undefined) patch.FIREBASE_PROJECT_ID = String(input.firebaseProjectId).trim();
  if (input.localOnly !== undefined) patch.LOCAL_ONLY = input.localOnly ? "1" : "0";

  const seen = new Set<string>();
  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq === -1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (key in patch) {
      seen.add(key);
      return `${key}=${patch[key as EditableKey]}`;
    }
    return line;
  });

  for (const key of Object.keys(patch) as EditableKey[]) {
    if (!seen.has(key)) nextLines.push(`${key}=${patch[key]}`);
  }

  fs.writeFileSync(envFilePath, nextLines.join("\n").replace(/\n{3,}/g, "\n\n"), "utf8");
  return getIntegrationSettings();
}
