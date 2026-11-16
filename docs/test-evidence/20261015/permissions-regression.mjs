import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
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
const login=async(side,name)=>ok(await call(null,'POST',`/${side}/auth/login`,{username:name,password:'123456'})).token;
const failures=[];
const admin=await login('admin','service01');
const aid=Number(sql("SELECT id FROM admin_user WHERE username='service01' AND role='ADMIN'"));
assert.ok(aid>0);
try {
 sql(`UPDATE admin_user SET role='DOCTOR' WHERE id=${aid}`);
 const r=await call(admin,'GET','/admin/user/page');
 console.log('Changed role old token response:',r.code);
 if(r.code!==401)failures.push('Old administrator token retains user-management permission after role change');
}finally{sql(`UPDATE admin_user SET role='ADMIN' WHERE id=${aid}`)}

const user=await login('client','lisi'),doctor=await login('admin','doctor01');
const pet=ok(await call(user,'POST','/client/pet',{name:'权限回归',species:'猫'}));
const session=ok(await call(user,'POST','/client/consult/sessions',{petId:pet.id,doctorId:1,symptom:'医生绑定变更回归'}));
const did=Number(sql("SELECT id FROM admin_user WHERE username='doctor01' AND doctor_id=1"));assert.ok(did>0);
const ws=new WebSocket(cfg.api.replace('http:','ws:')+'/ws/consult?token='+encodeURIComponent(doctor)+'&sessionId='+session.id);
const frames=[];ws.onmessage=e=>frames.push(JSON.parse(e.data));
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
try {
 for(let i=0;i<100&&!frames.some(f=>f.type==='HISTORY');i++)await delay(20);
 assert.ok(frames.some(f=>f.type==='HISTORY'));
 sql(`UPDATE admin_user SET doctor_id=NULL WHERE id=${did}`);
 const r=await call(doctor,'GET','/admin/consult/sessions');
 if(r.code!==401)failures.push('Old doctor token can read consultations after binding removed');
 ws.send(JSON.stringify({type:'CHAT',sessionId:session.id,msgType:'TEXT',content:'stale-doctor-binding'}));
 for(let i=0;i<100&&!frames.some(f=>f.type==='ERROR'||f.type==='MSG');i++)await delay(20);
 const count=sql(`SELECT COUNT(*) FROM consult_message WHERE session_id=${session.id} AND content='stale-doctor-binding'`);
 console.log('Removed doctor binding REST / persisted messages:',r.code,count);
 if(count!=='0'||!frames.some(f=>f.type==='ERROR'))failures.push('Existing socket can write under removed doctor binding');
}finally{ws.close();sql(`UPDATE admin_user SET doctor_id=1 WHERE id=${did}`)}
// A locally signed short-lived credential exercises real JWT expiry on an existing socket.
const [header,payload]=user.split('.');
const claims=JSON.parse(Buffer.from(payload,'base64url'));claims.exp=Math.floor(Date.now()/1000)+3;
const encoded=Buffer.from(JSON.stringify(claims)).toString('base64url');
const algorithm=JSON.parse(Buffer.from(header,'base64url')).alg;
const signature=createHmac({HS256:'sha256',HS384:'sha384',HS512:'sha512'}[algorithm],readFileSync('.tmp/qa-20261015/jwt-secret.txt','utf8')).update(header+'.'+encoded).digest('base64url');
const shortToken=header+'.'+encoded+'.'+signature;
const expiredSocket=new WebSocket(cfg.api.replace('http:','ws:')+'/ws/consult?token='+encodeURIComponent(shortToken)+'&sessionId='+session.id);
const expiredFrames=[];expiredSocket.onmessage=e=>expiredFrames.push(JSON.parse(e.data));
await new Promise((resolve,reject)=>{expiredSocket.onopen=resolve;expiredSocket.onerror=reject});
try{
 await delay(3500);
 assert.equal((await call(shortToken,'GET','/client/auth/profile')).code,401);
 expiredSocket.send(JSON.stringify({type:'CHAT',sessionId:session.id,msgType:'TEXT',content:'expired-jwt-message'}));
 for(let i=0;i<100&&!expiredFrames.some(f=>f.type==='MSG'||f.type==='ERROR');i++)await delay(20);
 const count=sql(`SELECT COUNT(*) FROM consult_message WHERE session_id=${session.id} AND content='expired-jwt-message'`);
 console.log('Expired JWT socket persisted messages:',count);
 if(count!=='0'||!expiredFrames.some(f=>f.type==='ERROR'))failures.push('Expired JWT retains write access on existing socket');
}finally{expiredSocket.close()}
assert.deepEqual(failures,[]);
console.log('PASS role changes and doctor binding revoke stale REST and WebSocket identity');
