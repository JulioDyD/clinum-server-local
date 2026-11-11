import "dotenv/config";
export const config = {
    localHttpPort: Number(process.env.LOCAL_HTTP_PORT ?? 8081),
    serialPort: process.env.SERIAL_PORT ?? "COM5",
    serialBaud: Number(process.env.SERIAL_BAUD ?? 115200),
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? "clinum-2",
    /** ID del doc locations/{id} en el web (vacío = sync de devices sin sede asociada) */
    locationId: process.env.LOCATION_ID ?? "",
    localDbFile: process.env.LOCAL_DB_FILE ?? "./data/clinum.db",
    localOnly: (process.env.LOCAL_ONLY === "1" || process.env.DISABLE_FIREBASE === "1" || (process.env.SERIAL_PORT ?? "").toLowerCase() === "none"),
    corsOrigin: process.env.CORS_ORIGIN ?? "*",
    /** Presencia: "aggregated" escribe un solo doc por sede; "legacy" mantiene el comportamiento anterior. */
    presenceMode: (process.env.PRESENCE_MODE ?? "aggregated"),
    /** Historial: "local" escribe care_history desde el puente; "cloud" lo deja a la Cloud Function. */
    historyWriter: (process.env.HISTORY_WRITER ?? "local"),
    /** Outbox durable local -> nube. Activo por defecto; OUTBOX=0 vuelve al envío directo. */
    outboxEnabled: process.env.OUTBOX !== "0",
    /** Pacientes: "web" bloquea la edición local y espeja Firestore; "local" mantiene la UI local. */
    patientsSource: (process.env.PATIENTS_SOURCE ?? "web"),
    /** Escucha legacy de devices_config (desactivada por defecto; ya no la escribe la web). */
    legacyDevicesConfig: process.env.LEGACY_DEVICES_CONFIG === "1",
    tls: {
        enabled: process.env.TLS_ENABLED === "1",
        certFile: process.env.TLS_CERT_FILE ?? "/etc/clinum-web-local/tls/server.crt",
        keyFile: process.env.TLS_KEY_FILE ?? "/etc/clinum-web-local/tls/server.key",
        redirectPort: Number(process.env.TLS_REDIRECT_PORT ?? 8080),
    },
};
