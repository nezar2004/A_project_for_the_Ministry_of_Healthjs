import express from "express";
import cors from "cors";

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GOOGLE_API_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((v) => v.trim()).filter(Boolean);
const requestBuckets = new Map();

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error("Origin is not allowed"));
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
  maxAge: 86400
}));

function rateLimit(req, res, next) {
  const key = req.ip || "unknown";
  const now = Date.now();
  const current = requestBuckets.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    requestBuckets.set(key, { startedAt: now, count: 1 });
    return next();
  }
  current.count += 1;
  if (current.count > 12) return res.status(429).json({ answer: "تم إرسال طلبات كثيرة. حاول مرة أخرى بعد دقيقة." });
  next();
}

const SYSTEM_GUIDANCE = `أنت مساعد توعوي داخل منصة صحية أردنية. أجب بالعربية الواضحة باختصار.
لا تشخّص الأمراض، ولا تصف أدوية أو جرعات، ولا تدّعي أنك طبيب. عند أعراض الطوارئ أو الخطر
وجّه المستخدم فورًا إلى الطوارئ أو الرقم 911 في الأردن. لا تطلب رقمًا وطنيًا أو كلمة مرور أو
بيانات طبية تعريفية. وضّح أن إجابتك معلومات عامة ولا تغني عن الطبيب.`;

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/", (_req, res) => res.type("text/plain").send("Amal health assistant API"));

app.post("/api/chat", rateLimit, async (req, res) => {
  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!API_KEY) return res.status(503).json({ answer: "المساعد غير متاح مؤقتًا." });
  if (!question) return res.status(400).json({ answer: "اكتب سؤالك أولًا." });
  if (question.length > 800) return res.status(400).json({ answer: "السؤال طويل جدًا. اختصره إلى أقل من 800 حرف." });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_GUIDANCE }] },
        contents: [{ role: "user", parts: [{ text: question }] }],
        generationConfig: { temperature: 0.25, maxOutputTokens: 450 }
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("Gemini request failed", response.status, data?.error?.status || "unknown");
      return res.status(502).json({ answer: "تعذر الحصول على إجابة الآن. حاول لاحقًا." });
    }
    const answer = data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim();
    res.json({ answer: answer || "لم أتمكن من إعداد إجابة مناسبة." });
  } catch (error) {
    console.error("Chat request error", error?.name || "Error");
    res.status(error?.name === "AbortError" ? 504 : 500).json({ answer: "حدث خطأ مؤقت أثناء الاتصال بالمساعد." });
  } finally {
    clearTimeout(timeout);
  }
});

app.use((error, _req, res, _next) => {
  console.error("Request rejected", error?.message || "Unknown error");
  res.status(403).json({ answer: "هذا المصدر غير مسموح له بالاتصال بالخدمة." });
});

app.listen(PORT, "0.0.0.0", () => console.log(`Amal API listening on port ${PORT}`));
