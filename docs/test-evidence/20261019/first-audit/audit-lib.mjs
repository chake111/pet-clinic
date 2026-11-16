import { readFileSync, appendFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import assert from 'node:assert/strict'
export const root = new URL('.', import.meta.url)
export const cfg = JSON.parse(readFileSync(new URL('runtime.json', root)))
export const actors = JSON.parse(readFileSync(new URL('actors.json', root)))
assert.match(cfg.db, /^pet_clinic_test_[a-f0-9]{8}$/)
assert.equal(cfg.api, 'http://127.0.0.1:8082/api')
const args = ['--defaults-extra-file=' + cfg.mysqlDefaultsFile, '-BN', '--default-character-set=utf8mb4']
const rawSql = q => execFileSync('mysql', [...args, '-e', q], {encoding:'utf8'}).trim()
export function guard() { assert.equal(rawSql('SELECT DATABASE(),@@port'), cfg.db+'\t3307') }
export function sql(q) { guard(); return rawSql(q) }
const secret = readFileSync(new URL('jwt-secret.txt',root),'utf8')
export function token(who, seconds=1800) {
 const a=actors[who], now=Math.floor(Date.now()/1000), enc=o=>Buffer.from(JSON.stringify(o)).toString('base64url')
 const s=enc({alg:'HS512'})+'.'+enc({sub:String(a.id),typ:a.typ,role:a.role,doctorId:a.doctorId,name:a.name,iat:now,exp:now+seconds})
 return s+'.'+createHmac('sha512',secret).update(s).digest('base64url')
}
export function record(label,data) { const v={time:new Date().toISOString(),label,...data}; appendFileSync(new URL('evidence.jsonl',root),JSON.stringify(v)+'\n'); console.log(label,JSON.stringify(data)) }
export async function request(who,method,path,body,expected) {
 guard(); const r=await fetch(cfg.api+path,{method,headers:{'Content-Type':'application/json',...(who?{Authorization:'Bearer '+token(who)}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)})
 const j=await r.json(); record('HTTP',{who,method,path,input:body,http:r.status,response:j}); if(expected!==undefined)assert.equal(j.code,expected,path);return j
}
export const ok=async(w,m,p,b)=>(await request(w,m,p,b,200)).data
export const delay=ms=>new Promise(r=>setTimeout(r,ms))
export async function room(who,id,seconds=1800,expectHistory=true) {
 guard(); const ws=new WebSocket('ws://127.0.0.1:8082/api/ws/consult?token='+token(who,seconds)+'&sessionId='+id),frames=[]; let closed=false
 ws.addEventListener('message',e=>{const f=JSON.parse(e.data);frames.push(f);record('WS',{who,sessionId:id,frame:f})});ws.addEventListener('close',()=>{closed=true});ws.addEventListener('error',()=>{})
 const take=async(type,p=()=>true,timeout=4000)=>{const end=Date.now()+timeout;while(Date.now()<end){const i=frames.findIndex(f=>f.type===type&&p(f));if(i>=0)return frames.splice(i,1)[0];await delay(20)}throw new Error('No '+type+' for '+who)}
 if(expectHistory)await take('HISTORY');else await take('READY')
 return {ws,frames,take,get closed(){return closed},send:p=>{record('WS_SEND',{who,sessionId:id,payload:p});ws.send(JSON.stringify({sessionId:id,...p}))}}
}
export async function lockSession(id) {
 guard(); const p=spawn('mysql',[...args,'--unbuffered'],{stdio:['pipe','pipe','pipe']});let output='';p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>record('LOCK_ERROR',{message:String(d)}))
 p.stdin.write('START TRANSACTION; SELECT id FROM consult_session WHERE id='+Number(id)+' FOR UPDATE; SELECT "LOCK_READY";\n')
 for(let i=0;i<100&&!output.includes('LOCK_READY');i++)await delay(20)
 assert.ok(output.includes('LOCK_READY'));record('LOCK_ACQUIRED',{id})
 return ()=>{p.stdin.end('COMMIT;\n');record('LOCK_RELEASED',{id})}
}
