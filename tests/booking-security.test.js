import test from "node:test";
import assert from "node:assert/strict";
import { createBookingService } from "../booking-service.js";
const patient={uid:"patient-a",email:"patient@example.test",project:"nabdapp-3a077"};
const other={uid:"patient-b",email:"other@example.test",project:"nabdapp-3a077"};
const doctor={uid:"doctor-a",email:"doctor@example.test",project:"dataofhosp"};
const imposter={uid:"imposter",email:"doctor@example.test",project:"dataofhosp"};
function harness() {
 const records=new Map();let failPath=null,queue=Promise.resolve();
 function snapshot(path){return{id:path.split("/").at(-1),exists:records.has(path),data:()=>structuredClone(records.get(path))}}
 function ref(path){return{path,id:path.split("/").at(-1),collection:name=>query(path+"/"+name),get:async()=>snapshot(path),set:async(value,options)=>{if(path===failPath)throw Error("write denied");records.set(path,structuredClone(options?.merge?{...records.get(path),...value}:value))}}}
 function query(path,filters=[],size=Infinity,cursor=""){
  return{path,filters,size,cursor,doc:id=>ref(path+"/"+id),where:(field,op,value)=>query(path,[...filters,{field,op,value}],size,cursor),limit:n=>query(path,filters,n,cursor),startAfter:s=>query(path,filters,size,s.id),
   get:async()=>({docs:[...records.keys()].filter(p=>p.startsWith(path+"/")&&p.split("/").length===path.split("/").length+1&&p.split("/").at(-1)>cursor&&filters.every(f=>records.get(p)[f.field]===f.value)).sort().slice(0,size).map(snapshot)})};
 }
 const db={collection:name=>query(name),runTransaction:async fn=>{
   const run=queue.then(async()=>{const writes=[];let wrote=false;
    const tx={get:async item=>{if(wrote)throw Error("read after write");return item.get()},set:(r,v,o)=>{wrote=true;if(r.path===failPath)throw Error("write rejected");writes.push([r.path,v,o?.merge])},update:(r,v)=>{wrote=true;if(r.path===failPath)throw Error("write rejected");writes.push([r.path,v,true])}};
    const value=await fn(tx);for(const[p,v,merge]of writes)records.set(p,structuredClone(merge?{...records.get(p),...v}:v));return value;
   });queue=run.catch(()=>{});return run;
 }};
 const role={enabled:true,auth_project:"dataofhosp",email:doctor.email,hospitalId:"h",departmentId:"dept",doctorId:"d"};
 records.set("doctorAccess/"+doctor.uid,role);
 const catalog=async()=>({hospitalId:"h",departmentId:"dept",doctorId:"d",hospital:{name:"Hospital",gov:"Amman",type:"governmental"},department:{title:"Clinic",basePrice:20},doctor:{id:"d",email:doctor.email,name:"Doctor",slotDuration:30}});
 const service=createBookingService({db,catalog,verifyToken:async token=>{if(token==="patient")return patient;if(token==="doctor")return doctor;throw Error("invalid")}});
 return {service,db,records,fail:path=>failPath=path,clear:()=>{for(const key of records.keys())if(!key.startsWith("doctorAccess/"))records.delete(key)}};
}
const input={booking_id:"Brequest1",hospital_id:"h",department_id:"dept",doctor_doc_id:"d",date:"2099-01-01",time:"09:00",customer_name:"Patient",customer_email:"p@example.test",customer_phone:"+962791234567",customer_note:"",has_insurance:false};
test("valid and invalid sessions are distinguished",async()=>{
 const {service}=harness();assert.equal((await service.identity("Bearer patient")).uid,patient.uid);
 await assert.rejects(service.identity(""),e=>e.status===401);await assert.rejects(service.identity("Bearer forged"),e=>e.status===401);
});
test("authority, names, price and duration come from trusted identity and catalog",async()=>{
 const {service,records}=harness();
 const result=await service.create(patient,{...input,user_uid:other.uid,doctor_email:"attacker@example.test",price:0,slot_duration:1,status:"APPROVED"});
 assert.equal(result.booking.user_uid,patient.uid);assert.equal(result.booking.price,20);assert.equal(result.booking.status,"PENDING");assert.equal(result.booking.doctor_email,doctor.email);assert.equal(result.booking.slot_duration,30);
 assert.equal(records.get("users/"+patient.uid+"/bookings/"+result.id).price,20);
});
test("concurrent requests reserve only one doctor interval",async()=>{
 const {service,records}=harness();
 const results=await Promise.allSettled([service.create(patient,input),service.create(other,{...input,booking_id:"Brequest2"})]);
 assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
 assert.equal([...records.keys()].filter(p=>p.startsWith("allBookings/")).length,1);
});
test("a retry with the same request id is idempotent",async()=>{
 const {service,records}=harness();const a=await service.create(patient,input),b=await service.create(patient,input);
 assert.equal(a.id,b.id);assert.equal([...records.keys()].filter(p=>p.startsWith("allBookings/")).length,1);
});
test("atomic writes roll back if the patient copy fails",async()=>{
 const h=harness();const crypto=await import("node:crypto");const id=crypto.createHash("sha256").update(patient.uid+"|"+input.booking_id).digest("hex");h.fail("users/"+patient.uid+"/bookings/"+id);
 await assert.rejects(h.service.create(patient,input));assert.equal([...h.records.keys()].filter(p=>!p.startsWith("doctorAccess/")).length,0);
});
test("patient A cannot view patient B's bookings",async()=>{
 const {service}=harness();await service.create(patient,input);
 assert.equal((await service.list(other)).bookings.length,0);assert.equal((await service.list(patient)).bookings.length,1);
});
test("availability exposes times but never patient names or contact details",async()=>{
 const {service}=harness();await service.create(patient,input);
 const result=await service.availability(other,{doctor_email:doctor.email,date:input.date});
 assert.equal(result.bookings.length,1);assert.deepEqual(Object.keys(result.bookings[0]).sort(),["date","slot_duration","status","time"]);
});
test("patient accounts and unapproved doctor uids cannot perform doctor actions",async()=>{
 const {service}=harness();const {id}=await service.create(patient,input);
 await assert.rejects(service.update(patient,id,{status:"APPROVED"}),e=>e.status===403);
 await assert.rejects(service.update(imposter,id,{status:"APPROVED"}),e=>e.status===403);
});
test("a doctor cannot modify another doctor's appointment",async()=>{
 const {service,records}=harness();const {id}=await service.create(patient,input);
 records.get("allBookings/"+id).doctor_email="another@example.test";
 await assert.rejects(service.update(doctor,id,{status:"APPROVED"}),e=>e.status===403);
});
test("doctor edits cannot change ownership or price",async()=>{
 const {service}=harness();const {id}=await service.create(patient,input);
 await assert.rejects(service.update(doctor,id,{user_uid:doctor.uid}),e=>e.status===400);
 await assert.rejects(service.update(doctor,id,{price:0}),e=>e.status===400);
});
test("rescheduling rejects occupied or outside-clinic times",async()=>{
 const {service,records}=harness();const first=await service.create(patient,input);
 await service.create(other,{...input,booking_id:"Bother",time:"10:00"});
 await assert.rejects(service.update(doctor,first.id,{status:"RESCHEDULED",date:input.date,time:"10:00"}),e=>e.status===409);
 await assert.rejects(service.update(doctor,first.id,{status:"RESCHEDULED",date:input.date,time:"20:00"}),e=>e.status===400);
 assert.equal(records.get("allBookings/"+first.id).time,"09:00");
});
test("cancellation updates both copies and releases the time",async()=>{
 const {service,records}=harness();const {id}=await service.create(patient,input);
 await service.update(doctor,id,{status:"CANCELLED"});
 assert.equal(records.get("allBookings/"+id).status,"CANCELLED");assert.equal(records.get("users/"+patient.uid+"/bookings/"+id).status,"CANCELLED");
 await service.create(other,{...input,booking_id:"Breplacement"});
});
test("cancelled and rejected appointments cannot be reopened",async()=>{
 const {service}=harness();const {id}=await service.create(patient,input);await service.update(doctor,id,{status:"REJECTED"});
 await assert.rejects(service.update(doctor,id,{status:"APPROVED"}),e=>e.status===409);
});
test("doctor notes are bounded and saved to both views",async()=>{
 const {service,records}=harness();const {id}=await service.create(patient,input);
 await assert.rejects(service.update(doctor,id,{doctor_notes:"x".repeat(5001)}),e=>e.status===400);
 await service.update(doctor,id,{doctor_notes:"Follow-up"});
 assert.equal(records.get("users/"+patient.uid+"/bookings/"+id).doctor_notes,"Follow-up");
});
test("stale doctor actions cannot overwrite a newer change",async()=>{
 const {service}=harness();const {id}=await service.create(patient,input);
 await service.update(doctor,id,{status:"APPROVED"});
 await assert.rejects(service.update(doctor,id,{status:"REJECTED",expected:{status:"PENDING",date:input.date,time:input.time}}),e=>e.status===409);
});
test("list pagination remains scoped to the caller",async()=>{
 const {service}=harness();await service.create(patient,input);await service.create(patient,{...input,booking_id:"Bnext",time:"10:00"});
 const first=await service.list(patient,{limit:1});const second=await service.list(patient,{limit:1,cursor:first.nextCursor});
 assert.equal(first.bookings.length,1);assert.equal(second.bookings.length,1);assert.notEqual(first.bookings[0].id,second.bookings[0].id);
});
test("availability updates require a verified doctor and boolean value",async()=>{
 const {service,records}=harness();await assert.rejects(service.setAvailability(patient,true),e=>e.status===403);
 await assert.rejects(service.setAvailability(doctor,"true"),e=>e.status===400);await service.setAvailability(doctor,true);assert.equal(records.get("doctors/"+doctor.uid).available,true);
});
