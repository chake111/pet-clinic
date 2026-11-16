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
for(let round=0;round<10;round++){
 const f=await fixture();
 ok(await call(user,'POST',`/client/appointment/${f.order.id}/pay`));
 const results=await Promise.all([
  call(user,'POST',`/client/appointment/${f.order.id}/cancel`),
  call(doctor,'POST',`/admin/appointment/${f.order.id}/accept`)
 ]);
 assert.equal(results.filter(r=>r.code===200).length,1,JSON.stringify(results));
 assert.ok(results.every(r=>r.code<500),JSON.stringify(results));
 const state=sql(`SELECT a.status,a.pay_status,s.remain_num FROM appointment a JOIN doctor_schedule s ON s.id=a.schedule_id WHERE a.id=${f.order.id}`);
 assert.ok(['3\t2\t2','1\t1\t1'].includes(state),state);
}
console.log('PASS 10 cancellation/acceptance races: single winner, payment and capacity consistent');
for(let round=0;round<10;round++){
 const f=await fixture();
 const pet=ok(await call(user,'POST','/client/pet',{name:'调号竞争',species:'猫'}));
 const results=await Promise.all([
  call(admin,'PUT',`/admin/schedule/${f.slot.id}`,{doctorId:1,workDate:f.slot.workDate,period:1,startTime:'08:30:00',endTime:'12:00:00',totalNum:1,status:1}),
  call(user,'POST','/client/appointment',{petId:pet.id,doctorId:1,scheduleId:f.slot.id,symptom:'调号时并发预约'})
 ]);
 assert.equal(results.filter(r=>r.code===200).length,1,JSON.stringify(results));
 assert.ok(results.every(r=>r.code<500),JSON.stringify(results));
 const state=sql(`SELECT s.total_num,s.remain_num,(SELECT COUNT(*) FROM appointment a WHERE a.schedule_id=s.id AND a.status<>3) FROM doctor_schedule s WHERE s.id=${f.slot.id}`);
 assert.ok(['1\t0\t1','2\t0\t2'].includes(state),state);
}
console.log('PASS 10 capacity-reduction/booking races: zero overselling and correct remaining seats');

