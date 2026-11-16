import assert from 'node:assert/strict'
import {ok,request,sql,record,room,delay} from './audit-lib.mjs'
const pets=[]
for(let i=0;i<4;i++)pets.push(await ok('zhangsan','POST','/client/pet',{name:'审计并发'+i,species:'猫'}))
const form={doctorId:1,workDate:'2099-12-20',period:1,startTime:'08:00:00',endTime:'12:00:00',totalNum:2,status:1}
const s=await ok('admin','POST','/admin/schedule',form)
const orderBody=p=>({petId:p.id,doctorId:1,scheduleId:s.id,symptom:'审计挂号'})
const first=await Promise.all(Array.from({length:4},()=>request('zhangsan','POST','/client/appointment',orderBody(pets[0]))))
assert.equal(first.filter(x=>x.code===200).length,1);assert.ok(first.every(x=>[200,400].includes(x.code)))
const order=first.find(x=>x.code===200).data
record('DUPLICATE_BOOKING_PASS',{requests:4,codes:first.map(x=>x.code),state:sql(`SELECT remain_num,last_queue_no FROM doctor_schedule WHERE id=${s.id}`)})
const last=await Promise.all(pets.slice(1).map(p=>request('zhangsan','POST','/client/appointment',orderBody(p))))
assert.equal(last.filter(x=>x.code===200).length,1);assert.ok(last.every(x=>[200,400].includes(x.code)))
assert.equal(sql(`SELECT remain_num FROM doctor_schedule WHERE id=${s.id}`),'0')
record('LAST_SLOT_PASS',{requests:3,codes:last.map(x=>x.code),orders:sql(`SELECT COUNT(*),COUNT(DISTINCT queue_no) FROM appointment WHERE schedule_id=${s.id}`)})
const winner=last.find(x=>x.code===200).data
for(const [w,m,p,b,c] of [
 ['lisi','GET',`/client/appointment/${order.id}`,undefined,404],
 ['lisi','POST',`/client/appointment/${order.id}/pay`,undefined,404],
 ['lisi','POST',`/client/appointment/${order.id}/cancel`,undefined,404],
 ['doctor02','GET',`/admin/appointment/${order.id}`,undefined,403],
 ['doctor02','POST',`/admin/appointment/${order.id}/cancel`,undefined,403],
 ['doctor02','POST',`/admin/appointment/${order.id}/accept`,undefined,403],
 ['admin','POST',`/admin/appointment/${order.id}/accept`,undefined,403],
 ['doctor01','POST',`/admin/appointment/${order.id}/accept`,undefined,400],
 ['doctor01','POST',`/admin/record/appointment/${order.id}`,{diagnosis:'尚未接诊'},400]
])await request(w,m,p,b,c)
const pays=await Promise.all([ok('zhangsan','POST',`/client/appointment/${order.id}/pay`),ok('zhangsan','POST',`/client/appointment/${order.id}/pay`)])
assert.equal(sql(`SELECT pay_status FROM appointment WHERE id=${order.id}`),'1')
await ok('admin','PUT',`/admin/schedule/${s.id}/stop`)
assert.equal(sql(`SELECT status,remain_num FROM doctor_schedule WHERE id=${s.id}`),'0\t0')
assert.equal(sql(`SELECT status,pay_status FROM appointment WHERE id=${order.id}`),'0\t1')
await request('zhangsan','POST','/client/appointment',orderBody(pets[3]),400)
await ok('admin','PUT',`/admin/schedule/${s.id}/resume`)
const cancels=await Promise.all([request('zhangsan','POST',`/client/appointment/${winner.id}/cancel`),request('admin','POST',`/admin/appointment/${winner.id}/cancel`)])
assert.equal(cancels.filter(x=>x.code===200).length,1)
assert.equal(sql(`SELECT remain_num FROM doctor_schedule WHERE id=${s.id}`),'1')
record('PAY_STOP_CANCEL_PASS',{payRequests:pays.length,cancelCodes:cancels.map(x=>x.code),remain:1})
await ok('doctor01','POST',`/admin/appointment/${order.id}/accept`)
await request('admin','POST',`/admin/record/appointment/${order.id}`,{diagnosis:'越权'},403)
await request('doctor02','POST',`/admin/record/appointment/${order.id}`,{diagnosis:'越权'},403)
const records=await Promise.all([ok('doctor01','POST',`/admin/record/appointment/${order.id}`,{diagnosis:'隔离诊断A'}),ok('doctor01','POST',`/admin/record/appointment/${order.id}`,{diagnosis:'隔离诊断B'})])
assert.equal(records[0].id,records[1].id);assert.equal(sql(`SELECT COUNT(*) FROM medical_record WHERE appointment_id=${order.id} AND deleted=0`),'1')
const rid=records[0].id
for(const [w,p,c] of [['lisi',`/client/record/${rid}`,404],['lisi',`/client/appointment/${order.id}/record`,404],['doctor02',`/admin/record/${rid}`,403],['doctor02',`/admin/record/appointment/${order.id}`,403]])await request(w,'GET',p,undefined,c)
await request('admin','DELETE',`/admin/record/${rid}`,undefined,403)
await request('admin','POST',`/admin/appointment/${order.id}/finish`,undefined,403)
await ok('doctor01','POST',`/admin/appointment/${order.id}/finish`)
const reviews=await Promise.all([request('zhangsan','POST','/client/review',{appointmentId:order.id,rating:5}),request('zhangsan','POST','/client/review',{appointmentId:order.id,rating:5})])
assert.equal(reviews.filter(x=>x.code===200).length,1);assert.ok(reviews.every(x=>[200,400].includes(x.code)))
assert.equal(sql(`SELECT COUNT(*) FROM doctor_review WHERE appointment_id=${order.id}`),'1')
const review=reviews.find(x=>x.code===200).data
await request('doctor02','POST',`/admin/review/${review.id}/reply`,{reply:'越权'},403)
await request('doctor01','PUT',`/admin/review/${review.id}/status?status=0`,undefined,403)
record('RECORD_REVIEW_PASS',{recordId:rid,concurrentSaveCount:2,activeRecords:1,reviewCodes:reviews.map(x=>x.code),orderId:order.id})
// Pay deadline + missed-visit lazy transition.
const p=await ok('zhangsan','POST','/client/appointment',orderBody(pets[3]))
sql(`UPDATE appointment SET create_time=DATE_SUB(NOW(),INTERVAL 31 MINUTE) WHERE id=${p.id}`)
await request('zhangsan','POST',`/client/appointment/${p.id}/pay`,undefined,400)
await ok('zhangsan','POST',`/client/appointment/${p.id}/cancel`)
const missed=await ok('zhangsan','POST','/client/appointment',orderBody(pets[3]));await ok('zhangsan','POST',`/client/appointment/${missed.id}/pay`)
sql(`UPDATE appointment SET appointment_date=DATE_SUB(CURDATE(),INTERVAL 1 DAY) WHERE id=${missed.id}`)
await request('zhangsan','POST',`/client/appointment/${missed.id}/cancel`,undefined,400)
assert.equal(sql(`SELECT status,pay_status FROM appointment WHERE id=${missed.id}`),'4\t1')
assert.equal(sql(`SELECT remain_num FROM doctor_schedule WHERE id=${s.id}`),'0')
record('DEADLINE_MISSED_PASS',{missedId:missed.id,status:4,payStatus:1,remain:0})
// Wrong user cannot subscribe, send, or mark read over WebSocket.
const session=await ok('zhangsan','POST','/client/consult/sessions',{petId:pets[0].id,doctorId:1,symptom:'归属验证'})
const intruder=await room('lisi',session.id,1800,false)
try{await intruder.take('ERROR');intruder.send({type:'CHAT',msgType:'TEXT',content:'AUDIT_INTRUDER',requestId:'intruder'});await intruder.take('ERROR');intruder.send({type:'READ'});await intruder.take('ERROR');assert.equal(sql(`SELECT COUNT(*) FROM consult_message WHERE session_id=${session.id}`),'0');record('WS_OWNERSHIP_PASS',{sessionId:session.id,unauthorizedMessageCount:0})}finally{intruder.ws.close()}
record('APPOINTMENTS_COMPLETE',{scheduleId:s.id})
