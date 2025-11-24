import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(bodyParser.json());
app.use(cors());

// IMPORTANT: use Railway provided port
const PORT = process.env.PORT || 3000;

const ai = new GoogleGenAI({
  apiKey: process.env.GOOGLE_API_KEY
});

app.post("/api/chat", async (req, res) => {
  const question = req.body.question;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        { parts: [{ text: question }] }
      ]
    });

    const answer =
      response.candidates?.[0]?.content?.parts?.[0]?.text ||
      "لم يصلني رد من الذكاء الاصطناعي.";

    res.json({ answer });

  } catch (e) {
    console.error("AI ERROR:", e);
    res.json({ answer: "خطأ في الاتصال بالسيرفر." });
  }
});

app.get("/", (req, res) => {
  res.send("Server is running!");
});

// IMPORTANT: listen on 0.0.0.0
app.listen(PORT, "0.0.0.0", () =>
  console.log(`Server running on port ${PORT}`)
);
