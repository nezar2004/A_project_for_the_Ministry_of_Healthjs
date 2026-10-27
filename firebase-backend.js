import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { Router } from "express";
import { createBookingService, BookingError } from "./booking-service.js";

function decodeValue(v) {
  if("stringValue" in v)return v.stringValue;
  if("integerValue" in v)return Number(v.integerValue);
  if("doubleValue" in v)return v.doubleValue;
  if("booleanValue" in v)return v.booleanValue;
  if("nullValue" in v)return null;
  if("arrayValue" in v)return (v.arrayValue.values||[]).map(decodeValue);
  if("mapValue" in v)return Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,x])=>[k,decodeValue(x)]));
  return null;
}
export async function loadCatalog({hospitalId,departmentId,doctorId}) {
  for(const value of [hospitalId,departmentId,doctorId])if(typeof value!=="string"||!value||value.length>128||value.includes("/"))throw new BookingError(400,"اختيار الجهة الطبية غير صالح.");
  const path="https://firestore.googleapis.com/v1/projects/dataofhosp/databases/(default)/documents/hospitals/"+encodeURIComponent(hospitalId);
  const paths=[path,path+"/departments/"+encodeURIComponent(departmentId),path+"/departments/"+encodeURIComponent(departmentId)+"/doctors/"+encodeURIComponent(doctorId)];
  const docs=await Promise.all(paths.map(async url=>{
    const response=await fetch(url,{signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new BookingError(response.status===404?404:503,"تعذر التحقق من سجل الجهة الطبية.");
    const result=await response.json();
    return Object.fromEntries(Object.entries(result.fields||{}).map(([k,v])=>[k,decodeValue(v)]));
  }));
  return {hospital:docs[0],department:docs[1],doctor:docs[2],hospitalId,departmentId,doctorId};
}
let cachedBackend;
export function getBookingBackend() {
  if(cachedBackend)return cachedBackend;
  const raw=process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if(!raw)return null;
  let credentials;
  try{credentials=JSON.parse(raw)}catch{throw new Error("Invalid booking service credentials");}
  if(credentials.project_id!=="dataofdoctor")throw new Error("Booking credentials must target dataofdoctor");
  const appName="amal-bookings";
  const app=getApps().find(a=>a.name===appName)||initializeApp({credential:cert(credentials),projectId:"dataofdoctor"},appName);
  const verifiers=Object.fromEntries(["nabdapp-3a077","dataofhosp"].map(project=>{
    const name="amal-verify-"+project;
    const authApp=getApps().find(a=>a.name===name)||initializeApp({projectId:project},name);
    return [project,getAuth(authApp)];
  }));
  const db=getFirestore(app);
  const verifyToken=async token=>{
    let project;
    try{project=JSON.parse(Buffer.from(token.split(".")[1],"base64url").toString()).aud}catch{throw new Error("Invalid token");}
    if(!verifiers[project])throw new Error("Invalid issuer");
    const verified=await verifiers[project].verifyIdToken(token);
    return {...verified,project};
  };
  const service=createBookingService({db,verifyToken,catalog:loadCatalog});
  const patientApp=getApps().find(a=>a.name==="amal-patient-lookup")||initializeApp({credential:cert(credentials),projectId:"nabdapp-3a077"},"amal-patient-lookup");
  cachedBackend={db,service,patientDb:getFirestore(patientApp)};
  return cachedBackend;
}
export function bookingRouter(backendProvider=getBookingBackend) {
  const router=Router();
  const buckets=new Map();
  router.use((req,_res,next)=>{if (!req.path.startsWith("/bookings") && !req.path.startsWith("/doctor/") && req.path!=="/booking-health") return next("router");next();});
  router.use((_req,res,next)=>{res.setHeader("Cache-Control","private, no-store");next()});
  router.get("/booking-health",async(_req,res)=>{
    try{
      const backend=backendProvider();
      if(!backend)return res.status(503).json({ready:false});
      await backend.db.collection("_system").doc("booking-health").get();
      res.json({ready:true});
    }catch{res.status(503).json({ready:false})}
  });
  router.use(async(req,res,next)=>{
    try{
      const backend=backendProvider();
      if(!backend)throw new BookingError(503,"خدمة الحجز قيد الإعداد.");
      req.bookingService=backend.service;
      req.bookingUser=await backend.service.identity(req.headers.authorization);
      const time=Date.now();
      for(const [key,b] of buckets)if(time-b.start>=60000)buckets.delete(key);
      const key=req.bookingUser.project+":"+req.bookingUser.uid;
      const bucket=buckets.get(key)||{start:time,count:0};
      if(!buckets.has(key)&&buckets.size>=5000)throw new BookingError(429,"الخدمة مشغولة. حاول لاحقًا.");
      bucket.count++;buckets.set(key,bucket);
      if(bucket.count>120)throw new BookingError(429,"طلبات كثيرة. حاول بعد دقيقة.");
      next();
    }catch(error){next(error)}
  });
  function handle(fn){return async(req,res,next)=>{try{res.json(await fn(req))}catch(error){next(error)}}}
  router.get("/bookings/availability",handle(req=>req.bookingService.availability(req.bookingUser,req.query)));
  router.get("/bookings",handle(req=>req.bookingService.list(req.bookingUser,req.query)));
  router.post("/bookings",handle(req=>req.bookingService.create(req.bookingUser,req.body||{})));
  router.patch("/bookings/:id",handle(req=>req.bookingService.update(req.bookingUser,req.params.id,req.body||{})));
  router.get("/doctor/profile",handle(req=>req.bookingService.doctorProfile(req.bookingUser)));
  router.patch("/doctor/profile",handle(req=>req.bookingService.setAvailability(req.bookingUser,req.body?.available)));
  router.use((error,_req,res,_next)=>{
    const status=error instanceof BookingError?error.status:500;
    if(status===500)console.error("Booking request failed",error?.code||error?.name||"Error");
    res.status(status).json({answer:status===500?"تعذر إتمام العملية الآن. حاول مجددًا.":error.message});
  });
  return router;
}
