import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import http from 'node:http'
import {token,ok,request,actors,record} from './audit-lib.mjs'
const repo='<repo>/'
const vue=await import(pathToFileURL(repo+'frontend/node_modules/vue/index.mjs'))
const format=await import(pathToFileURL(repo+'frontend/src/utils/format.js'))
const script=readFileSync(repo+'frontend/src/views/admin/MySchedule.vue','utf8').match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/import[\s\S]*?from\s+['"][^'"]+['"]/g,'')
const bindings={...vue,onMounted:()=>{},onBeforeUnmount:()=>{},localNow:()=>({date:'2026-10-16',hhmm:'12:00'}),slotEnded:format.slotEnded}
const state=new Function(...Object.keys(bindings),script+'\nreturn slotState')(...Object.values(bindings))
for(const [row,want]of [[{doctorAvailable:false,status:1,remainNum:2},'已停诊'],[{status:1,remainNum:2,workDate:'2026-10-15',endTime:'12:00:00'},'已结束'],[{status:1,remainNum:2,workDate:'2026-10-17',endTime:'12:00:00'},'可预约'],[{status:1,remainNum:0,workDate:'2026-10-17',endTime:'12:00:00'},'已约满']])assert.equal(state(row).label,want)
record('CURRENT_SCHEDULE_CHECK_PASS',{checks:4,actualFunction:'slotState',sourceChanged:false})
// Execute the existing downstream socket assertions separately, unchanged.
const original=readFileSync(repo+'frontend/tests/business-rules.test.mjs','utf8')
const tail=original.slice(original.indexOf('// 使用真实客户端，替换网络连接与令牌读取。'))
const prefix=`import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';const source=p=>readFileSync(${JSON.stringify(repo+'frontend/src/')}+p,'utf8');\n`
await import('data:text/javascript;base64,'+Buffer.from(prefix+tail).toString('base64'))
record('DOWNSTREAM_SOCKET_CHECK_PASS',{checks:['ACK','ERROR','disconnect'],originalAssertionsUnchanged:true,fullOriginalSuiteStillFails:true})
// The incoming handshake already rejects a disabled account after old connection is closed.
await ok('admin','PUT',`/admin/user/${actors.zhangsan.id}/status?status=0`)
try{
 const status=await new Promise((resolve,reject)=>{
  const req=http.get('http://127.0.0.1:8082/api/ws/consult?sessionId=4',{headers:{Authorization:'Bearer '+token('zhangsan'),Connection:'Upgrade',Upgrade:'websocket','Sec-WebSocket-Version':'13','Sec-WebSocket-Key':Buffer.alloc(16,1).toString('base64')}},res=>{res.resume();resolve(res.statusCode)})
  req.on('upgrade',(res,socket)=>{socket.destroy();resolve(res.statusCode)});req.on('error',reject)
 });assert.equal(status,401);record('DISABLED_HANDSHAKE_CONTROL',{http:status})
}finally{await ok('admin','PUT',`/admin/user/${actors.zhangsan.id}/status?status=1`)}
