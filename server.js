import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GOOGLE_API_KEY;

app.post("/api/chat", async (req, res) => {
  const question = req.body.question;

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: question }]
            }
          ]
        })
      }
    );

    const data = await response.json();

    const answer =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "لم يصلني رد من الذكاء الاصطناعي.";

    res.json({ answer });

  } catch (err) {
    console.error(err);
    res.json({ answer: "خطأ في الاتصال بالسيرفر." });
  }
});

app.get("/", (req, res) => {
  res.send("Server is running!");
});

app.listen(PORT, "0.0.0.0", () =>
  console.log("Server running on port " + PORT)
);
