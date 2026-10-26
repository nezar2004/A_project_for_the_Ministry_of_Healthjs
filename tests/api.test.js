import test from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV = "test";
process.env.GOOGLE_API_KEY = "fake-key-for-local-test";
process.env.ALLOWED_ORIGINS = "https://nezar2004.github.io";
const { app } = await import("../server.js");
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const url = "http://127.0.0.1:" + server.address().port;
const realFetch = globalThis.fetch;
test.after(() => new Promise(resolve => server.close(resolve)));
async function request(body, options = {}) {
  return realFetch(url + "/api/chat", {method:"POST", headers:{"Content-Type":"application/json",Origin:"https://nezar2004.github.io",...options.headers},body:typeof body === "string" ? body : JSON.stringify(body)});
}
test("health endpoint responds without exposing secrets", async () => {
  const response = await realFetch(url + "/health");
  assert.equal(response.status,200); assert.deepEqual(await response.json(),{status:"ok"});
});
test("allowed frontend origin gets a successful Arabic reply",async()=>{
  globalThis.fetch=async()=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text:"رد تجريبي"}]}}]})});
  try{const response=await request({question:"مرحبا",language:"ar"});assert.equal(response.status,200);assert.equal(response.headers.get("access-control-allow-origin"),"https://nezar2004.github.io");assert.equal((await response.json()).answer,"رد تجريبي");}finally{globalThis.fetch=realFetch}
});
test("English chat keeps medical guidance and requests English",async()=>{
  let instructions;
  globalThis.fetch=async(_url,options)=>{instructions=JSON.parse(options.body).systemInstruction.parts[0].text;return{ok:true,json:async()=>({candidates:[{content:{parts:[{text:"Hello"}]}}]})}};
  try{assert.equal((await request({question:"Hello",language:"en"})).status,200);assert.ok(instructions.includes("Respond in English"));assert.ok(instructions.includes("لا تشخّص"));}finally{globalThis.fetch=realFetch}
});
test("blank or oversized questions are rejected",async()=>{
  assert.equal((await request({question:"  "})).status,400);
  assert.equal((await request({question:"x".repeat(801)})).status,400);
});
test("malformed JSON returns 400 instead of misleading permission error",async()=>{
  assert.equal((await request("{broken")).status,400);
});
test("oversized payload returns 413",async()=>{
  assert.equal((await request({question:"x".repeat(20000)})).status,413);
});
test("unknown origins cannot call the browser API",async()=>{
  assert.equal((await request({question:"test"},{headers:{Origin:"https://unknown.example"}})).status,403);
});
test("upstream rejection and timeouts return safe errors",async()=>{
  globalThis.fetch=async()=>({ok:false,status:429,json:async()=>({error:{status:"RESOURCE_EXHAUSTED",message:"private upstream detail"}})});
  try{const response=await request({question:"test"});assert.equal(response.status,502);assert.ok(!JSON.stringify(await response.json()).includes("private upstream"));}finally{globalThis.fetch=realFetch}
  globalThis.fetch=async()=>{const error=Error();error.name="AbortError";throw error};
  try{assert.equal((await request({question:"test"})).status,504)}finally{globalThis.fetch=realFetch}
});
test("rate limiting isolates different client addresses",async()=>{
  globalThis.fetch=async()=>({ok:true,json:async()=>({candidates:[{content:{parts:[{text:"ok"}]}}]})});
  try {
    for(let i=0;i<12;i++)assert.equal((await request({question:"test"},{headers:{"X-Forwarded-For":"192.0.2.10"}})).status,200);
    assert.equal((await request({question:"test"},{headers:{"X-Forwarded-For":"192.0.2.10"}})).status,429);
    assert.equal((await request({question:"test"},{headers:{"X-Forwarded-For":"192.0.2.11"}})).status,200);
  }finally{globalThis.fetch=realFetch}
});
