import OpenAI from "openai";
import { config } from "../config.js";
export const xkiro = new OpenAI({
    apiKey: config.xkiro.apiKey,
    baseURL: config.xkiro.baseURL,
});
export async function preguntar(prompt) {
    const r = await xkiro.chat.completions.create({
        model: config.xkiro.model,
        messages: [{ role: "user", content: prompt }],
    });
    return r.choices[0].message.content;
}
