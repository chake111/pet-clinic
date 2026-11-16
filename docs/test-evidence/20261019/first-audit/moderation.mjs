import assert from 'node:assert/strict'
import {ok,request,room,record,sql,delay} from './audit-lib.mjs'
const pet=await ok('zhangsan','POST','/client/pet',{name:'审计处置宠物',species:'猫'})
const s=await ok('zhangsan','POST','/client/consult/sessions',{petId:pet.id,doctorId:1,symptom:'处置权限验证'})
const dr=await room('doctor01',s.id);let user
try{
 dr.send({type:'CHAT',msgType:'TEXT',content:'AUDIT_HIDDEN_BEFORE_JOIN',requestId:'hidden-before-join'})
 const ack=await dr.take('ACK',f=>f.requestId==='hidden-before-join'),mid=ack.message.id
 await ok('admin','PUT',`/admin/consult/message/${mid}/hidden?hidden=1&reason=audit`)
 user=await room('zhangsan',s.id)
 const before=await ok('zhangsan','GET',`/client/consult/${s.id}/messages`)
 assert.ok(before.records.every(x=>x.id!==mid))
 await ok('admin','PUT',`/admin/consult/${s.id}/moderate?moderateStatus=2&reason=audit`)
 await user.take('MODERATION')
 await request('zhangsan','GET',`/client/consult/${s.id}/messages`,undefined,404)
 await ok('admin','PUT',`/admin/consult/message/${mid}/hidden?hidden=0`)
 const leaked=await user.take('MESSAGE_VISIBILITY',f=>f.messageId===mid&&f.hidden===0)
 record('MODERATED_ROOM_CONTENT_DISCLOSED',{sessionId:s.id,messageId:mid,frame:leaked,state:sql(`SELECT status,moderate_status FROM consult_session WHERE id=${s.id}`)})
 user.ws.close();await delay(100)
 const retry=await room('zhangsan',s.id,1800,false)
 try{const rejected=await retry.take('ERROR');record('MODERATION_RECONNECT_CONTROL',{error:rejected,historyReceived:retry.frames.some(f=>f.type==='HISTORY')})}finally{retry.ws.close()}
}finally{dr.ws.close();user?.ws.close()}
