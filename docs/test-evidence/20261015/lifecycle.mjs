import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const cfg=JSON.parse(readFileSync('.tmp/qa-20261015/runtime.json'));
const sql=q=>execFileSync('mysql',[`--defaults-extra-file=${cfg.mysqlDefaultsFile}`,'-BN','-e',q],{encoding:'utf8'}).trim();
assert.match(cfg.db,/^pet_clinic_test_[a-f0-9]{8}$/);
assert.equal(sql('SELECT DATABASE()'),cfg.db);assert.equal(sql('SELECT @@port'),'3307');
async function call(token,method,path,body){return (await fetch(cfg.api+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)})).json()}
const ok=r=>{assert.equal(r.code,200,JSON.stringify(r));return r.data};
const login=async(side,name)=>ok(await call(null,'POST',`/${side}/auth/login`,{username:name,password:'123456'})).token;
const user=await login('client','lisi'),admin=await login('admin','admin'),doctor=await login('admin','doctor01');
async function fixture(){
 const pet=ok(await call(user,'POST','/client/pet',{name:'生命周期复测',species:'猫'}));
 const workDate=sql('SELECT DATE_ADD(MAX(work_date),INTERVAL 1 DAY) FROM doctor_schedule');
 const slot=ok(await call(admin,'POST','/admin/schedule',{doctorId:1,workDate,period:1,startTime:'08:30:00',endTime:'12:00:00',totalNum:2,status:1}));
 const order=ok(await call(user,'POST','/client/appointment',{petId:pet.id,doctorId:1,scheduleId:slot.id,symptom:'生命周期检查'}));
 return {pet,slot,order};
}
const f=await fixture();
const pays=await Promise.all(Array.from({length:8},()=>call(user,'POST',`/client/appointment/${f.order.id}/pay`)));
assert.ok(pays.every(r=>r.code===200));
assert.equal(sql(`SELECT remain_num FROM doctor_schedule WHERE id=${f.slot.id}`),'1');
console.log('PASS repeated payment: 8 requests, one occupied seat');
ok(await call(admin,'PUT',`/admin/schedule/${f.slot.id}/stop`));
ok(await call(doctor,'POST',`/admin/appointment/${f.order.id}/accept`));
assert.notEqual((await call(user,'POST',`/client/appointment/${f.order.id}/cancel`)).code,200);
ok(await call(doctor,'POST',`/admin/appointment/${f.order.id}/finish`));
const records=await Promise.all(Array.from({length:8},()=>call(doctor,'POST',`/admin/record/appointment/${f.order.id}`,{diagnosis:'并发病历复测',chiefComplaint:'精神状态观察'})));
assert.ok(records.every(r=>r.code===200),JSON.stringify(records));
assert.equal(sql(`SELECT COUNT(*) FROM medical_record WHERE appointment_id=${f.order.id}`),'1');

console.log('PASS stopped schedule existing paid visit, cancellation guard, post-visit record and 8 concurrent record saves');
const reviews=await Promise.all(Array.from({length:8},()=>call(user,'POST','/client/review',{appointmentId:f.order.id,rating:5,content:'并发评价复测'})));
assert.equal(reviews.filter(r=>r.code===200).length,1);assert.ok(reviews.every(r=>r.code<500),JSON.stringify(reviews));
assert.equal(sql(`SELECT COUNT(*) FROM doctor_review WHERE appointment_id=${f.order.id}`),'1');
console.log('PASS 8 concurrent reviews: one review and business errors for duplicates');
const expired=await fixture();
sql(`UPDATE appointment SET create_time=DATE_SUB(NOW(),INTERVAL 2 HOUR) WHERE id=${expired.order.id}`);
assert.notEqual((await call(user,'POST',`/client/appointment/${expired.order.id}/pay`)).code,200);
console.log('PASS expired payment rejected; waiting for real scheduled cleanup');
const end=Date.now()+75000;
while(Date.now()<end&&sql(`SELECT status FROM appointment WHERE id=${expired.order.id}`)!=='3')await delay(1500);
assert.equal(sql(`SELECT status,pay_status,cancel_by FROM appointment WHERE id=${expired.order.id}`),'3\t0\tSYSTEM');
assert.equal(sql(`SELECT remain_num FROM doctor_schedule WHERE id=${expired.slot.id}`),'2');
console.log('PASS actual scheduler cancelled expired order and returned exactly one seat');


