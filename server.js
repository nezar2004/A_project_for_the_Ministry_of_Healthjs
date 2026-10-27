import express from "express";
import cors from "cors";
import { bookingRouter } from "./firebase-backend.js";

import { patientLoginRouter } from "./patient-login.js";

import { generateChatReply } from "./chat-provider.js";

export const app = express();
app.set("trust proxy", 1);
const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GOOGLE_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map((v) => v.trim()).filter(Boolean);
const requestBuckets = new Map();
const MAX_BUCKETS = 5000;

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
  methods: ["GET", "POST", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
  maxAge: 86400
}));

function rateLimit(req, res, next) {
  for (const [ip, bucket] of requestBuckets) { if (Date.now() - bucket.startedAt >= 60_000) requestBuckets.delete(ip); }
  if (requestBuckets.size >= MAX_BUCKETS && !requestBuckets.has(req.ip)) return res.status(429).json({ answer: "الخدمة مشغولة. حاول لاحقًا." });
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

app.use("/api", patientLoginRouter());
app.use("/api", bookingRouter());

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/", (_req, res) => res.type("text/plain").send("Amal health assistant API"));

app.post("/api/chat", rateLimit, async (req, res) => {
  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (!API_KEY) return res.status(503).json({ answer: "المساعد غير متاح مؤقتًا." });
  if (!question) return res.status(400).json({ answer: "اكتب سؤالك أولًا." });
  if (question.length > 800) return res.status(400).json({ answer: "السؤال طويل جدًا. اختصره إلى أقل من 800 حرف." });

  const english=req.body.language==='en';
  try {
    const answer=await generateChatReply({apiKey:API_KEY,model:GEMINI_MODEL,question,instructions:SYSTEM_GUIDANCE+(english?'\nRespond in English. Keep the same medical safety boundaries.':'')});
    res.json({answer});
  }catch(error){
    console.error('Chat provider failure',error?.code||'UNKNOWN');
    const code=error?.code;
    const answer=code==='PROVIDER_TIMEOUT'?(english?'The assistant took too long after a second attempt. Please try again shortly.':'تأخر رد المساعد رغم إعادة المحاولة. حاول مجددًا بعد قليل.'):
      code==='PROVIDER_QUOTA'?(english?'The assistant has reached its usage limit. Please try later.':'وصل المساعد إلى حد الاستخدام المتاح. حاول لاحقًا.'):
      code==='PROVIDER_SAFETY'?(english?'I can offer general health information, but cannot provide a diagnosis or prescription.':'أستطيع تقديم معلومات صحية عامة، لكن لا أقدّم تشخيصًا أو وصفة طبية.'):
      (english?'The AI service is temporarily unavailable. Please try again shortly.':'خدمة الذكاء الاصطناعي غير متاحة مؤقتًا. حاول بعد قليل.');
    res.status(error?.status||502).json({answer,code:code||'PROVIDER_ERROR'});
  }
});

app.use((error, _req, res, _next) => {
  if (error.type === "entity.too.large") return res.status(413).json({ answer: "الطلب كبير جدًا." });
  if (error instanceof SyntaxError && "body" in error) return res.status(400).json({ answer: "صيغة الطلب غير صحيحة." });
  console.error("Request rejected", error?.message || "Unknown error");
  res.status(403).json({ answer: "هذا المصدر غير مسموح له بالاتصال بالخدمة." });
});

if (process.env.NODE_ENV !== "test") app.listen(PORT, "0.0.0.0", () => console.log(`Amal API listening on port ${PORT}`));
