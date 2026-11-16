import assert from 'node:assert/strict'
import { ok, request, sql, actors, room, delay, record, lockSession } from './audit-lib.mjs'
const conns=[]
try {
 const pet=await ok('zhangsan','POST','/client/pet',{name:'审计隔离宠物',species:'猫'})
 const newSession=()=>ok('zhangsan','POST','/client/consult/sessions',{petId:pet.id,doctorId:1,symptom:'隔离审计'})
 const s=await newSession()
 // Horizontal and vertical boundaries.
 for(const [w,m,p,b,code] of [
 ['lisi','GET',`/client/pet/${pet.id}`,undefined,404],
 ['lisi','PUT',`/client/pet/${pet.id}`,{name:'越权',species:'猫'},404],
 ['lisi','DELETE',`/client/pet/${pet.id}`,undefined,404],
 ['lisi','GET',`/client/consult/sessions/${s.id}`,undefined,403],
 ['lisi','POST',`/client/consult/${s.id}/close`,undefined,403],
 ['doctor02','POST',`/admin/consult/${s.id}/accept`,undefined,403],
 ['doctor02','GET',`/admin/consult/${s.id}/messages`,undefined,403],
 ['admin','POST',`/admin/consult/${s.id}/accept`,undefined,403],
 ['doctor01','PUT',`/admin/consult/${s.id}/moderate?moderateStatus=2&reason=audit`,undefined,403],
 ['zhangsan','GET','/admin/user/page',undefined,403],
 [null,'GET',`/client/pet/${pet.id}`,undefined,401]
 ])await request(w,m,p,b,code)
 record('AUTH_REST_BOUNDARIES_PASS',{checks:11})
 // Account disable must also stop outbound delivery on an already open connection.
 const user=await room('zhangsan',s.id),dr=await room('doctor01',s.id);conns.push(user,dr)
 await request('admin','PUT',`/admin/user/${actors.zhangsan.id}/status?status=0`,undefined,200)
 await request('zhangsan','GET',`/client/consult/sessions/${s.id}`,undefined,401)
 dr.send({type:'CHAT',msgType:'TEXT',content:'AUDIT_AFTER_DISABLE',requestId:'disabled-recipient'})
 const disabledFrame=await user.take('MSG',f=>f.message?.content==='AUDIT_AFTER_DISABLE')
 record('DISABLED_ACCOUNT_RECEIVED',{userId:actors.zhangsan.id,message:disabledFrame.message,closed:user.closed})
 user.send({type:'PING'});await user.take('ERROR');await delay(100)
 record('DISABLE_MINIMAL_CONTAINMENT',{afterClientFrameClosed:user.closed})
 await request('admin','PUT',`/admin/user/${actors.zhangsan.id}/status?status=1`,undefined,200)
 dr.ws.close();await delay(100)
 // Expired token: make no client frames after expiration.
 const expiring=await room('zhangsan',s.id,2),dr2=await room('doctor01',s.id);conns.push(expiring,dr2)
 await delay(2400)
 dr2.send({type:'CHAT',msgType:'TEXT',content:'AUDIT_AFTER_EXPIRY',requestId:'expired-recipient'})
 const expiredFrame=await expiring.take('MSG',f=>f.message?.content==='AUDIT_AFTER_EXPIRY')
 record('EXPIRED_TOKEN_RECEIVED',{message:expiredFrame.message,closed:expiring.closed})
 expiring.send({type:'PING'});await expiring.take('ERROR');await delay(100);dr2.ws.close()
 // Controlled two-request race; row lock arranges the order, no production data.
 const race=await newSession(),u=await room('zhangsan',race.id);conns.push(u)
 const release=await lockSession(race.id)
 try {
  const closing=request('doctor01','POST',`/admin/consult/${race.id}/close`,{summary:'AUDIT_CLOSED'},200)
  await delay(350)
  u.send({type:'CHAT',msgType:'TEXT',content:'AUDIT_RACE_MESSAGE',requestId:'race-close-send'})
  await delay(350);release()
  await closing
  const ack=await u.take('ACK',f=>f.requestId==='race-close-send')
  record('CLOSE_SEND_RACE',{ack:ack.message,state:sql(`SELECT id,status,summary,last_message FROM consult_session WHERE id=${race.id}`),messages:sql(`SELECT id,msg_type,content FROM consult_message WHERE session_id=${race.id} ORDER BY id`)})
 } catch(e) {release();record('RACE_RESULT',{error:e.message})}
 // Sequential rejection is the control for the race.
 u.send({type:'CHAT',msgType:'TEXT',content:'AUDIT_SEQUENTIAL_AFTER_CLOSE',requestId:'sequential'})
 const error=await u.take('ERROR',f=>f.requestId==='sequential');record('CLOSE_SEQUENTIAL_CONTROL',{error,count:sql(`SELECT COUNT(*) FROM consult_message WHERE session_id=${race.id} AND content='AUDIT_SEQUENTIAL_AFTER_CLOSE'`)})
 record('VERIFY_COMPLETE',{petId:pet.id,sessionId:s.id,raceSessionId:race.id})
} finally {for(const c of conns)c.ws.close();sql(`UPDATE sys_user SET status=1 WHERE id=${actors.zhangsan.id}`)}
