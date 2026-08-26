import "dotenv/config";
export const config = {
    localHttpPort: Number(process.env.LOCAL_HTTP_PORT ?? 8081),
    serialPort: process.env.SERIAL_PORT ?? "COM5",
    serialBaud: Number(process.env.SERIAL_BAUD ?? 115200),
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? "clinum-2",
    localDbFile: process.env.LOCAL_DB_FILE ?? "./data/clinum.db",
    localOnly: (process.env.LOCAL_ONLY === "1" || process.env.DISABLE_FIREBASE === "1" || (process.env.SERIAL_PORT ?? "").toLowerCase() === "none"),
};
