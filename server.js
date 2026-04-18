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
  console.log("=== /api/chat called ===");
  console.log("BODY:", req.body);
  console.log("API KEY EXISTS:", !!API_KEY);

  const question = req.body.question;
  console.log("QUESTION:", question);

  if (!API_KEY) {
    return res.status(500).json({
      answer: "GOOGLE_API_KEY غير موجود في متغيرات البيئة."
    });
  }

  if (!question || !question.trim()) {
    return res.status(400).json({
      answer: "الرجاء إرسال السؤال."
    });
  }

  try {
   const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY
      },
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

    console.log("GEMINI STATUS:", response.status);

    const data = await response.json();
    console.log("RAW RESPONSE:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return res.status(response.status).json({
        answer: data?.error?.message || "حدث خطأ من Gemini API."
      });
    }

    const answer =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "لم يصلني رد من الذكاء الاصطناعي.";

    console.log("FINAL ANSWER:", answer);

    return res.json({ answer });
  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json({
      answer: "حدث خطأ أثناء الاتصال بالسيرفر."
    });
  }
});

app.get("/", (req, res) => {
  res.send("Server is running!");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
