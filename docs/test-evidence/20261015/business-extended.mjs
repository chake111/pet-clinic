import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const cfg=JSON.parse(readFileSync('.tmp/qa-20261015/runtime.json'));
const sql=q=>execFileSync('mysql',[`--defaults-extra-file=${cfg.mysqlDefaultsFile}`,'-BN','-e',q],{encoding:'utf8'}).trim();
assert.match(cfg.db,/^pet_clinic_test_[a-f0-9]{8}$/);
assert.equal(sql('SELECT DATABASE(),@@port'),cfg.db+'\t3307');
assert.equal(cfg.api,'http://127.0.0.1:8082/api');
async function call(token,method,path,body){return (await fetch(cfg.api+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)})).json()}
const ok=r=>{assert.equal(r.code,200,JSON.stringify(r));return r.data};
const deny=r=>assert.ok([400,401,403,404,409].includes(r.code),JSON.stringify(r));
const login=async(side,name)=>ok(await call(null,'POST',`/${side}/auth/login`,{username:name,password:'123456'})).token;
const user=await login('client','lisi'),other=await login('client','zhangsan'),admin=await login('admin','admin'),doctor=await login('admin','doctor01'),wrong=await login('admin','doctor11');
const pet=()=>call(user,'POST','/client/pet',{name:'扩展检查',species:'猫'}).then(ok);
const slot=async()=>ok(await call(admin,'POST','/admin/schedule',{doctorId:1,workDate:sql('SELECT DATE_ADD(MAX(work_date),INTERVAL 1 DAY) FROM doctor_schedule'),period:1,startTime:'08:30:00',endTime:'12:00:00',totalNum:1,status:1}));
const animal=await pet();let chosen;
for(let round=0;round<5;round++){
 const s=await slot(),pets=await Promise.all(Array.from({length:8},pet));
 const results=await Promise.all(pets.map(p=>call(user,'POST','/client/appointment',{petId:p.id,doctorId:1,scheduleId:s.id,symptom:'争抢最后一个号源'})));
 assert.equal(results.filter(r=>r.code===200).length,1);results.filter(r=>r.code!==200).forEach(deny);
 assert.equal(sql(`SELECT remain_num FROM doctor_schedule WHERE id=${s.id}`),'0');
 chosen=results.find(r=>r.code===200).data;
}
console.log('PASS last seat: 5 rounds x 8 different pets, one success and zero remaining');
for(const token of [null,'invalid-token',other])deny(await call(token,'GET',`/client/appointment/${chosen.id}`));
deny(await call(user,'GET','/admin/user/page'));
deny(await call(doctor,'GET','/admin/user/page'));
for(const token of [admin,wrong]){
 deny(await call(token,'POST',`/admin/appointment/${chosen.id}/accept`));
 deny(await call(token,'POST',`/admin/record/appointment/${chosen.id}`,{diagnosis:'越权测试'}));
}
deny(await call(user,'POST','/client/review',{appointmentId:chosen.id,rating:5}));
deny(await call(doctor,'POST',`/admin/record/appointment/${chosen.id}`,{diagnosis:'尚未接诊'}));
console.log('PASS ownership, clinical role, invalid login and pending record/review guards');
// Deliberately discard the successful response, then retry the same payment.
await call(user,'POST',`/client/appointment/${chosen.id}/pay`);
ok(await call(user,'POST',`/client/appointment/${chosen.id}/pay`));
assert.equal(sql(`SELECT pay_status FROM appointment WHERE id=${chosen.id}`),'1');
ok(await call(doctor,'POST',`/admin/appointment/${chosen.id}/accept`));
const record=ok(await call(doctor,'POST',`/admin/record/appointment/${chosen.id}`,{diagnosis:'已接诊病历'}));
deny(await call(admin,'DELETE',`/admin/record/${record.id}`));
deny(await call(other,'GET',`/client/record/${record.id}`));
console.log('PASS discarded payment response retry and record ownership/deletion guards');
const count=sql('SELECT COUNT(*) FROM appointment');
const session=ok(await call(user,'POST','/client/consult/sessions',{petId:animal.id,doctorId:1,symptom:'断线恢复与权限'}));
assert.equal(sql('SELECT COUNT(*) FROM appointment'),count);
for(const token of [admin,wrong])deny(await call(token,'POST',`/admin/consult/${session.id}/accept`));
deny(await call(other,'GET',`/client/consult/${session.id}/messages`));
ok(await call(doctor,'POST',`/admin/consult/${session.id}/accept`));
deny(await call(user,'POST',`/client/consult/${session.id}/close`));
async function connect(token){
 const ws=new WebSocket(cfg.api.replace('http:','ws:')+'/ws/consult?token='+encodeURIComponent(token)+'&sessionId='+session.id);
 const frames=[];ws.onmessage=e=>frames.push(JSON.parse(e.data));
 await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
 for(let i=0;i<200&&!frames.some(f=>f.type==='HISTORY');i++)await delay(10);
 assert.ok(frames.some(f=>f.type==='HISTORY'));return {ws,frames};
}
async function send(c,content){
 const n=c.frames.length;c.ws.send(JSON.stringify({type:'CHAT',sessionId:session.id,msgType:'TEXT',content}));
 for(let i=0;i<200&&!c.frames.slice(n).some(f=>f.type==='MSG'||f.type==='ERROR');i++)await delay(10);
 return c.frames.slice(n);
}
let owner=await connect(user);const doc=await connect(doctor);
try{
 await send(owner,'before-disconnect');owner.ws.close();await delay(100);
 for(let i=0;i<25;i++)assert.ok((await send(doc,'offline-'+i)).some(f=>f.type==='MSG'));
 owner=await connect(user);
 const recent=owner.frames.find(f=>f.type==='HISTORY').messages;
 assert.equal(recent.length,20);assert.ok(recent.some(m=>m.content==='offline-24'));
 const earlier=ok(await call(user,'GET',`/client/consult/${session.id}/messages?beforeId=${Math.min(...recent.map(m=>m.id))}&pageSize=50`));
 const rows=earlier.records||earlier.list||earlier.rows;
 assert.ok(rows.some(m=>m.content==='offline-0'),JSON.stringify(earlier));
 assert.equal(sql(`SELECT user_unread FROM consult_session WHERE id=${session.id}`),'0');
 ok(await call(doctor,'POST',`/admin/consult/${session.id}/close`,{summary:'恢复后结束'}));
 assert.ok((await send(owner,'after-close')).some(f=>f.type==='ERROR'));
 assert.equal(sql(`SELECT COUNT(*) FROM consult_message WHERE session_id=${session.id} AND content='after-close'`),'0');
 ok(await call(admin,'PUT',`/admin/consult/${session.id}/moderate?moderateStatus=2&reason=QA`));
 deny(await call(user,'GET',`/client/consult/${session.id}/messages`));
 ok(await call(admin,'GET',`/admin/consult/${session.id}/messages`));
 console.log('PASS independent consult, 25 offline messages, recent/history pagination, unread reset, closure and moderation');
}finally{owner.ws.close();doc.ws.close()}
