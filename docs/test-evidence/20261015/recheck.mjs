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
let successes=0;
for(let round=0;round<10;round++){
 const pet=ok(await call(user,'POST','/client/pet',{name:`复测${round}`,species:'猫',gender:1}));
 const workDate=sql('SELECT DATE_ADD(MAX(work_date),INTERVAL 1 DAY) FROM doctor_schedule');
 const slot=ok(await call(admin,'POST','/admin/schedule',{doctorId:1,workDate,period:1,startTime:'08:30:00',endTime:'12:00:00',totalNum:8,status:1}));
 const request=()=>call(user,'POST','/client/appointment',{petId:pet.id,doctorId:1,scheduleId:slot.id,symptom:'复测重复下单'});
 const results=await Promise.all(Array.from({length:8},request));
 assert.equal(results.filter(r=>r.code===200).length,1);assert.equal(sql(`SELECT remain_num FROM doctor_schedule WHERE id=${slot.id}`),'7');
 const order=results.find(r=>r.code===200).data;
 ok(await call(user,'POST',`/client/appointment/${order.id}/cancel`));ok(await request());successes++;
}
console.log('PASS duplicate booking: 10 rounds x 8 requests; cancel and rebook passed');
const pet=ok(await call(user,'POST','/client/pet',{name:'停用复测',species:'猫'}));
const session=ok(await call(user,'POST','/client/consult/sessions',{petId:pet.id,doctorId:1,symptom:'停用账号复测'}));
ok(await call(doctor,'POST',`/admin/consult/${session.id}/accept`));
const profile=ok(await call(user,'GET','/client/auth/profile'));
const ws=new WebSocket(cfg.api.replace('http:','ws:')+'/ws/consult?token='+encodeURIComponent(user)+'&sessionId='+session.id);
const frames=[];ws.onmessage=e=>frames.push(JSON.parse(e.data));
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
try{
 for(let i=0;i<100&&!frames.some(f=>f.type==='HISTORY');i++)await delay(20);
 assert.ok(frames.some(f=>f.type==='HISTORY'));
 ok(await call(admin,'PUT',`/admin/user/${profile.id}/status?status=0`));
 ws.send(JSON.stringify({type:'CHAT',sessionId:session.id,msgType:'TEXT',content:'disabled-recheck'}));
 for(let i=0;i<100&&ws.readyState!==WebSocket.CLOSED;i++)await delay(20);
 assert.equal(ws.readyState,WebSocket.CLOSED);assert.ok(frames.some(f=>f.type==='ERROR'));
 assert.equal(sql(`SELECT COUNT(*) FROM consult_message WHERE session_id=${session.id} AND content='disabled-recheck'`),'0');
 console.log('PASS disabled account: error returned, socket closed, no message persisted');
}finally{ws.close();ok(await call(admin,'PUT',`/admin/user/${profile.id}/status?status=1`));}

const animal=ok(await call(user,'POST','/client/pet',{name:'正常就诊复测',species:'猫'}));
const workDate=sql('SELECT DATE_ADD(MAX(work_date),INTERVAL 1 DAY) FROM doctor_schedule');
const schedule=ok(await call(admin,'POST','/admin/schedule',{doctorId:1,workDate,period:1,startTime:'08:30:00',endTime:'12:00:00',totalNum:2,status:1}));
const order=ok(await call(user,'POST','/client/appointment',{petId:animal.id,doctorId:1,scheduleId:schedule.id,symptom:'完整就诊复测'}));
ok(await call(user,'POST',`/client/appointment/${order.id}/pay`));
ok(await call(doctor,'POST',`/admin/appointment/${order.id}/accept`));
ok(await call(doctor,'POST',`/admin/record/appointment/${order.id}`,{diagnosis:'复测记录',chiefComplaint:'食欲下降'}));
ok(await call(doctor,'POST',`/admin/appointment/${order.id}/finish`));
ok(await call(user,'POST','/client/review',{appointmentId:order.id,rating:5,content:'复测评价'}));
assert.equal(sql(`SELECT status,pay_status,is_reviewed FROM appointment WHERE id=${order.id}`),'2\t1\t1');
assert.equal(sql(`SELECT remain_num FROM doctor_schedule WHERE id=${schedule.id}`),'1');
assert.equal(sql(`SELECT COUNT(*) FROM medical_record WHERE appointment_id=${order.id}`),'1');
assert.equal(sql(`SELECT COUNT(*) FROM doctor_review WHERE appointment_id=${order.id}`),'1');
console.log('PASS normal appointment: booking, payment, acceptance, record, finish, review and database consistency');
