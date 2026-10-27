import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import {patientLoginRouter} from '../patient-login.js';
async function harness(fn,{emails=['patient@example.test'],verified=true}={}) {
 let reads=0,calls=0;
 const query={where(field,op,id){assert.equal(field,'nationalID');assert.equal(op,'==');assert.equal(id,'1234567890');return this},limit(n){assert.equal(n,2);return this},async get(){reads++;return{docs:emails.map(email=>({data:()=>({email})}))}}};
 const app=express();app.use(express.json());
 app.use('/api',patientLoginRouter({backend:()=>({patientDb:{collection:()=>query}}),authenticate:async(email,password)=>{calls++;assert.equal(password,'test-password');return verified?{email}:null}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const request=async(body)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/patient-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:r.status,data:await r.json(),cache:r.headers.get('cache-control')}};
 try{await fn({request,counts:()=>({reads,calls})})}finally{await new Promise(r=>server.close(r))}
}
const input={nationalID:'1234567890',password:'test-password'};
test('national ID returns only the matching email after password verification',async()=>harness(async({request,counts})=>{const r=await request(input);assert.equal(r.status,200);assert.deepEqual(r.data,{email:'patient@example.test'});assert.equal(r.cache,'no-store');assert.deepEqual(counts(),{reads:1,calls:1})}));
test('wrong passwords never reveal the patient email',async()=>harness(async({request})=>{const r=await request(input);assert.equal(r.status,401);assert.equal('email' in r.data,false)},{verified:false}));
test('missing and ambiguous national IDs return the same generic failure',async()=>{let message;for(const emails of [[],['a@example.test','b@example.test']])await harness(async({request,counts})=>{const r=await request(input);assert.equal(r.status,401);assert.equal('email'in r.data,false);if(message)assert.equal(r.data.answer,message);message=r.data.answer;assert.equal(counts().calls,1)},{emails})});
test('malformed IDs are rejected before querying private profiles',async()=>harness(async({request,counts})=>{assert.equal((await request({...input,nationalID:'bad'})).status,400);assert.equal(counts().reads,0)}));
test('repeated attempts are limited before further password checks',async()=>harness(async({request,counts})=>{for(let n=0;n<5;n++)await request(input);assert.equal((await request(input)).status,429);assert.equal(counts().calls,5)}));
