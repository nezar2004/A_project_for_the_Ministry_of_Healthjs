import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeApp,deleteApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {createBookingService} from '../booking-service.js';
test('real Firestore transactions preserve conflicts, mirrors and doctor workflow',async()=>{
 assert.equal(process.env.FIRESTORE_EMULATOR_HOST,'127.0.0.1:8089');
 const app=initializeApp({projectId:'demo-amal-bookings'},'booking-integration');const db=getFirestore(app);
 const p={uid:'test-patient',email:'patient@example.test',project:'nabdapp-3a077'};
 const d={uid:'test-doctor',email:'doctor@example.test',project:'dataofhosp'};
 const role={enabled:true,email:d.email,auth_project:d.project,hospitalId:'h',departmentId:'dep',doctorId:'d'};
 await db.doc('doctorAccess/'+d.uid).set(role);
 const service=createBookingService({db,verifyToken:async()=>p,catalog:async ids=>({ ...ids,hospital:{name:'Test clinic'},department:{title:'Test department',basePrice:20},doctor:{name:'Test doctor',email:d.email,slotDuration:30}})});
 const input={booking_id:'emulator-test',hospital_id:'h',department_id:'dep',doctor_doc_id:'d',date:'2099-01-01',time:'09:00',customer_name:'Synthetic Patient',customer_email:p.email,customer_phone:'+962791234567'};
 try {
  const attempts=await Promise.allSettled([service.create(p,input),service.create({...p,uid:'other-patient'},{...input,booking_id:'other-request'})]);
  assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);assert.equal(attempts.filter(a=>a.status==='rejected'&&a.reason.status===409).length,1);
  const winner=attempts.find(a=>a.status==='fulfilled').value;const uid=winner.booking.user_uid;
  assert.ok((await db.doc('users/'+uid+'/bookings/'+winner.id).get()).exists);
  await service.update(d,winner.id,{status:'APPROVED'});
  await service.update(d,winner.id,{doctor_notes:'Synthetic note'});
  await service.update(d,winner.id,{status:'RESCHEDULED',date:input.date,time:'10:00'});
  let mirror=(await db.doc('users/'+uid+'/bookings/'+winner.id).get()).data();assert.equal(mirror.time,'10:00');assert.equal(mirror.doctor_notes,'Synthetic note');
  await service.update(d,winner.id,{status:'CANCELLED'});
  assert.equal((await db.doc('users/'+uid+'/bookings/'+winner.id).get()).data().status,'CANCELLED');
  await service.create(p,{...input,booking_id:'released-slot',time:'10:00'});
  assert.equal((await service.list({...p,uid:'unrelated'})).bookings.length,0);
 } finally {await db.terminate();await deleteApp(app)}
});
