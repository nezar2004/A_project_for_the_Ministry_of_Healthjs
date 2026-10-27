import {Router} from 'express';
import {getBookingBackend} from './firebase-backend.js';
const GENERIC='الرقم الوطني أو كلمة المرور غير صحيحة';
const PATIENT_KEY='AIzaSyC4l0BaiwsxguCFPWBEF_5xoUv45PWjHqk'; // Public Firebase web configuration, not a server secret.
export function patientLoginRouter({backend=getBookingBackend,authenticate=authenticatePassword,clock=Date.now}={}) {
 const router=Router(),buckets=new Map();
 router.post('/patient-login',async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  const now=clock();for(const[k,v]of buckets)if(now-v.start>=60000)buckets.delete(k);
  const key=req.ip||'unknown',bucket=buckets.get(key)||{start:now,count:0};
  if((!buckets.has(key)&&buckets.size>=5000)||++bucket.count>5)return res.status(429).json({answer:'محاولات كثيرة. حاول بعد دقيقة.'});buckets.set(key,bucket);
  const {nationalID,password}=req.body||{};
  if(typeof nationalID!=='string'||!/^\d{10}$/.test(nationalID)||typeof password!=='string'||password.length<6||password.length>4096)return res.status(400).json({answer:GENERIC});
  try{
   const db=backend()?.patientDb;if(!db)return res.status(503).json({answer:'تسجيل الدخول غير متاح مؤقتًا.'});
   const matches=await db.collection('users').where('nationalID','==',nationalID).limit(2).get();
   const candidate=matches.docs.length===1?matches.docs[0].data().email:null;
   // Always check a password upstream, including unknown/ambiguous IDs, without exposing a profile.
   const email=typeof candidate==='string'?candidate.trim().toLowerCase():'unregistered-patient@invalid.example';
   const verified=await authenticate(email,password);
   if(!candidate||!verified||verified.email?.toLowerCase()!==email)return res.status(401).json({answer:GENERIC});
   return res.json({email});
  }catch(error){if(error?.name==='AbortError'||error?.name==='TimeoutError')return res.status(503).json({answer:'تسجيل الدخول غير متاح مؤقتًا.'});return res.status(401).json({answer:GENERIC})}
 });return router;
}
async function authenticatePassword(email,password){
 const response=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key='+PATIENT_KEY,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(15000),body:JSON.stringify({email,password,returnSecureToken:true})});
 if(!response.ok)return null;const data=await response.json();return{email:data.email};
}
