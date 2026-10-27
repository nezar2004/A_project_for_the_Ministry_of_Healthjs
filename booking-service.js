import { createHash } from "node:crypto";
import { Booking as A } from "./booking-core.js";

export class BookingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new BookingError(status, message); };
const clean = (value, max, required = true) => {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) fail(400, "تحقق من بيانات الحجز.");
  return value.trim();
};
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T12:00:00Z")) && new Date(value + "T12:00:00Z").toISOString().slice(0,10) === value;
const email = value => clean(value,254).toLowerCase();
const dayId = (doctorEmail,date) => createHash("sha256").update(doctorEmail+"|"+date).digest("hex");
const refId = (uid,key) => createHash("sha256").update(uid+"|"+key).digest("hex");
function assertFuture(date,time) {
  if (!validDate(date) || !Number.isFinite(A.minutes(time)) || date < A.dateInZone() || (date === A.dateInZone() && time <= A.clockInZone())) fail(400, "اختر موعدًا في المستقبل.");
}
function overlaps(a,b) {
  return A.occupies(a) && A.occupies(b) && a.date === b.date && A.overlaps(a.time,a.slot_duration,b.time,b.slot_duration);
}
function assertNoConflict(records,next,ignoreId) {
  if (records.some(b => b.id !== ignoreId && overlaps(b,next))) fail(409, "هذا الوقت محجوز. اختر موعدًا آخر.");
}
function serialize(doc) {
  const data = doc.data();
  return { ...data, id:doc.id, updatedAt:data.updatedAt?.toMillis?.() || data.updatedAt || null };
}

export function createBookingService({ db, verifyToken, catalog, now = () => Date.now() }) {
  async function identity(header) {
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || token.length > 10000) fail(401,"سجل الدخول أولًا.");
    try {
      const user = await verifyToken(token);
      if (!user?.uid || !user?.email || !["nabdapp-3a077","dataofhosp"].includes(user.project)) fail(401,"جلسة الدخول غير صالحة.");
      return {uid:user.uid,email:user.email.toLowerCase(),project:user.project};
    } catch { fail(401,"انتهت جلسة الدخول. سجل الدخول مجددًا."); }
  }
  function patient(user) { if (user.project !== "nabdapp-3a077") fail(403,"هذه الخدمة مخصصة لحساب المريض."); }
  async function doctor(user) {
    if (user.project !== "dataofhosp") fail(403,"هذه الخدمة مخصصة للطبيب.");
    const snap = await db.collection("doctorAccess").doc(user.uid).get();
    const role = snap.exists ? snap.data() : null;
    if (!role || role.enabled !== true || role.email !== user.email || role.auth_project !== user.project) fail(403,"هذا الحساب غير مخوّل كطبيب.");
    return role;
  }
  function mainRef(id) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail(400,"رقم الحجز غير صالح.");
    return db.collection("allBookings").doc(id);
  }
  async function list(user,{cursor = "",limit = 200} = {}) {
    let query;
    if (user.project === "nabdapp-3a077") query = db.collection("users").doc(user.uid).collection("bookings");
    else { await doctor(user); query = db.collection("allBookings").where("doctor_email","==",user.email); }
    // Firestore's default document-id order supports a stable cursor.
    if (cursor) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(cursor)) fail(400,"مؤشر القائمة غير صالح.");
      const cursorSnap = await query.doc?.(cursor)?.get?.();
      if (cursorSnap?.exists) query = query.startAfter(cursorSnap);
      else {
        const collectionRef = user.project === "nabdapp-3a077" ? db.collection("users").doc(user.uid).collection("bookings") : db.collection("allBookings");
        const previous = await collectionRef.doc(cursor).get();
        if (!previous.exists || (user.project === "dataofhosp" && previous.data().doctor_email !== user.email)) fail(400,"مؤشر القائمة غير صالح.");
        query = query.startAfter(previous);
      }
    }
    const size = Math.min(200,Math.max(1,Number(limit)||200));
    const snap = await query.limit(size).get();
    const records = snap.docs.map(serialize);
    return {bookings:records,nextCursor:snap.docs.length === size ? snap.docs.at(-1).id : null};
  }
  async function availability(user,{doctor_email,date}) {
    const doctorEmail=email(doctor_email || "");
    if(!validDate(date || "")) fail(400,"التاريخ غير صالح.");
    const snap=await db.collection("allBookings").where("doctor_email","==",doctorEmail).where("date","==",date).get();
    return {bookings:snap.docs.map(d=>d.data()).filter(A.occupies).map(b=>({date:b.date,time:b.time,slot_duration:Number(b.slot_duration)||30,status:b.status}))};
  }
  async function create(user,input) {
    patient(user);
    const requestId=clean(input.booking_id,100);
    if(!/^[A-Za-z0-9_-]+$/.test(requestId)) fail(400,"معرّف الطلب غير صالح.");
    const selected = await catalog({
      hospitalId:clean(input.hospital_id,128),
      departmentId:clean(input.department_id,128),
      doctorId:clean(input.doctor_doc_id,128)
    });
    const doctorEmail=email(selected.doctor.email);
    const date=clean(input.date,10),time=clean(input.time,5);
    assertFuture(date,time);
    if(!A.slots(selected.doctor,date).includes(time))fail(400,"الوقت خارج جدول الطبيب.");
    const phone=A.phone(input.customer_phone);
    if(!phone)fail(400,"رقم الهاتف غير صالح.");
    const customerEmail=email(input.customer_email);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail))fail(400,"البريد الإلكتروني غير صالح.");
    let insurance=null;
    if(input.has_insurance === true) insurance={company:clean(input.insurance_details?.company,100),policy:clean(input.insurance_details?.policy,100),note:clean(input.insurance_details?.note || "",500,false)};
    let price=Number(selected.department.basePrice ?? 0);
    if(!Number.isFinite(price)||price<0||price>100000)fail(503,"تعذر حساب التكلفة.");
    const copay=selected.department.insuranceCopayRate;
    if(insurance && copay != null && Number.isFinite(Number(copay)) && Number(copay)>=0 && Number(copay)<=1)price=Math.round(price*Number(copay)*100)/100;
    const record={
      booking_id:requestId,user_uid:user.uid,user_email:user.email,
      doctor_id:String(selected.doctor.doctorKey ?? selected.doctor.id ?? selected.doctorId),
      doctor_email:doctorEmail,doctor_name:String(selected.doctor.name || selected.doctor.doctor_name || ""),
      hospital_id:selected.hospitalId,hospital_name:String(selected.hospital.name || ""),
      department_id:selected.departmentId,department_title:String(selected.department.title || ""),
      doctor_doc_id:selected.doctorId,gov:String(selected.hospital.gov || ""),
      facility_type:String(selected.hospital.type || ""),status:"PENDING",date,time,
      slot_duration:Number(selected.doctor.slotDuration)||30,price,currency:selected.department.currency || selected.hospital.currency || "JOD",
      country:"JO",time_zone:"Asia/Amman",has_insurance:!!insurance,insurance_details:insurance,
      booked_for:input.booked_for === "other" ? "other" : "self",
      customer_name:clean(input.customer_name,150),customer_email:customerEmail,customer_phone:phone,
      customer_note:clean(input.customer_note || "",2000,false),createdAt:now()
    };
    const main=mainRef(refId(user.uid,requestId));
    const mirror=db.collection("users").doc(user.uid).collection("bookings").doc(main.id);
    const reservation=db.collection("appointmentSlots").doc(dayId(doctorEmail,date));
    record.source_booking_doc_id=mirror.id;
    await db.runTransaction(async tx=>{
      const prior=await tx.get(main);
      if(prior.exists){
        const previous=prior.data();
        if(previous.user_uid!==user.uid || previous.date!==date || previous.time!==time || previous.doctor_email!==doctorEmail)fail(409,"معرّف الطلب مستخدم لحجز آخر.");
        return;
      }
      const lock=await tx.get(reservation);
      const occupied=await tx.get(db.collection("allBookings").where("doctor_email","==",doctorEmail).where("date","==",date));
      assertNoConflict(occupied.docs.map(serialize),record);
      const entries={...(lock.exists ? lock.data().entries || {} : {})};
      assertNoConflict(Object.entries(entries).map(([id,b])=>({...b,id})),record);
      entries[main.id]={date,time,slot_duration:record.slot_duration,status:record.status};
      tx.set(reservation,{entries,updatedAt:now()});
      tx.set(main,record);tx.set(mirror,record);
    });
    return {id:main.id,booking:record};
  }
  async function update(user,id,input) {
    const access = await doctor(user);
    const ref=mainRef(id);
    const allowed=["status","date","time","reschedule_reason","doctor_notes","expected"];
    if(Object.keys(input).some(k=>!allowed.includes(k)))fail(400,"حقول التعديل غير مسموحة.");
    const patch={updatedAt:now(),reviewed_by_uid:user.uid};
    if("doctor_notes" in input){patch.doctor_notes=clean(input.doctor_notes,5000,false);patch.doctor_notes_by_uid=user.uid;patch.doctor_notes_updatedAt=now();}
    if("status" in input){
      if(!["APPROVED","REJECTED","CANCELLED","RESCHEDULED"].includes(input.status))fail(400,"حالة الحجز غير صالحة.");
      patch.status=input.status;
    }
    if(input.status==="RESCHEDULED"){
      patch.date=clean(input.date,10);patch.time=clean(input.time,5);assertFuture(patch.date,patch.time);
      patch.reschedule_reason=clean(input.reschedule_reason || "",1000,false);

    }else if("date" in input || "time" in input)fail(400,"استخدم إجراء تغيير الموعد.");
    await db.runTransaction(async tx=>{
      const snapshot=await tx.get(ref);
      if(!snapshot.exists)fail(404,"الحجز غير موجود.");
      const current=snapshot.data();
      if(current.doctor_email!==user.email)fail(403,"لا تملك صلاحية تعديل هذا الحجز.");
      if(patch.status==='RESCHEDULED') {
        const selected=await catalog(current.doctor_doc_id ? {hospitalId:current.hospital_id,departmentId:current.department_id,doctorId:current.doctor_doc_id} : access);
        if(email(selected.doctor.email)!==user.email)fail(403,"سجل الطبيب لا يطابق الحجز.");
        if(!A.slots(selected.doctor,patch.date).includes(patch.time))fail(400,"الوقت خارج جدول الطبيب.");
        patch.slot_duration=Number(selected.doctor.slotDuration)||30;
      }
      if(input.expected && ["date","time","status"].some(k=>input.expected[k]!==current[k]))fail(409,"تغيّر الحجز. حدّث القائمة وحاول مجددًا.");
      if(patch.status && ["REJECTED","CANCELLED"].includes(current.status) && patch.status!==current.status)fail(409,"لا يمكن إعادة فتح حجز ملغى أو مرفوض.");
      if (!patch.status) {
        tx.update(ref,patch);
        if(current.user_uid && current.source_booking_doc_id)tx.set(db.collection("users").doc(current.user_uid).collection("bookings").doc(current.source_booking_doc_id),patch,{merge:true});
        return;
      }
      const next={...current,...patch};
      if(patch.status && ["APPROVED","RESCHEDULED"].includes(patch.status))assertFuture(next.date,next.time);
      const oldRef=db.collection("appointmentSlots").doc(dayId(current.doctor_email,current.date));
      const newRef=db.collection("appointmentSlots").doc(dayId(next.doctor_email,next.date));
      const oldSnap=await tx.get(oldRef),newSnap=oldRef.path===newRef.path?oldSnap:await tx.get(newRef);
      const oldEntries={...(oldSnap.exists?oldSnap.data().entries||{}:{})};
      const nextEntries=oldRef.path===newRef.path?oldEntries:{...(newSnap.exists?newSnap.data().entries||{}:{})};
      if(A.occupies(next)){
        const busy=await tx.get(db.collection("allBookings").where("doctor_email","==",user.email).where("date","==",next.date));
        assertNoConflict(busy.docs.map(serialize),next,id);
        assertNoConflict(Object.entries(nextEntries).map(([key,b])=>({...b,id:key})),next,id);
      }
      delete oldEntries[id];
      if(A.occupies(next))nextEntries[id]={date:next.date,time:next.time,slot_duration:Number(next.slot_duration)||30,status:next.status};
      else delete nextEntries[id];
      tx.set(oldRef,{entries:oldEntries,updatedAt:now()});
      if(oldRef.path!==newRef.path)tx.set(newRef,{entries:nextEntries,updatedAt:now()});
      tx.update(ref,patch);
      if(current.user_uid && current.source_booking_doc_id)tx.set(db.collection("users").doc(current.user_uid).collection("bookings").doc(current.source_booking_doc_id),patch,{merge:true});
    });
    return {ok:true};
  }
  async function doctorProfile(user) {
    const access=await doctor(user);
    const selected=await catalog(access);
    const saved=await db.collection("doctors").doc(user.uid).get();
    return {doctor_id:String(selected.doctor.doctorKey??selected.doctor.id??selected.doctorId),name:selected.doctor.name||"",email:user.email,user_uid:user.uid,hospital_name:selected.hospital.name||"",department_title:selected.department.title||"",specialty:selected.doctor.specialty||selected.department.title||"",available:saved.exists?!!saved.data().available:!!selected.doctor.available};
  }
  async function setAvailability(user,value) {
    await doctor(user);if(typeof value!=="boolean")fail(400,"حالة التوفر غير صالحة.");
    await db.collection("doctors").doc(user.uid).set({available:value,updatedAt:now()},{merge:true});return {ok:true};
  }
  return {identity,list,availability,create,update,doctorProfile,setAvailability};
}
