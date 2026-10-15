import "dotenv/config";
export const config = {
    localHttpPort: Number(process.env.LOCAL_HTTP_PORT ?? 8081),
    serialPort: process.env.SERIAL_PORT ?? "COM5",
    serialBaud: Number(process.env.SERIAL_BAUD ?? 115200),
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? "clinum-2",
    localDbFile: process.env.LOCAL_DB_FILE ?? "./data/clinum.db",
    localOnly: (process.env.LOCAL_ONLY === "1" || process.env.DISABLE_FIREBASE === "1" || (process.env.SERIAL_PORT ?? "").toLowerCase() === "none"),
    corsOrigin: process.env.CORS_ORIGIN ?? "*",
    xkiro: {
        apiKey: process.env.XKIRO_API_KEY,
        baseURL: process.env.XKIRO_BASE_URL ?? "https://api.xkiro.com/v1",
        model: process.env.XKIRO_MODEL ?? "qwen/qwen3.8-max:free",
    },
};
