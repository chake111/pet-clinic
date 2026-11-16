"""Prepare one repeatable browser demo; snapshot afterwards with business_qa.py."""
import json
import urllib.request
from business_qa import config, sql, OUT

c = config()


def call(token, path, body):
    request = urllib.request.Request(c['api'] + path, data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
    result = json.load(urllib.request.urlopen(request))
    assert result['code'] == 200, result
    return result['data']


owner = call(None, '/client/auth/login', {'username': 'zhangsan', 'password': '123456'})['token']
admin = call(None, '/admin/auth/login', {'username': 'admin', 'password': '123456'})['token']
day = sql(c, 'SELECT DATE_ADD(CURRENT_DATE(),INTERVAL 1 DAY)')
row = sql(c, f"SELECT id,remain_num FROM doctor_schedule WHERE doctor_id=1 AND work_date='{day}' AND period=3 AND status=1")
if row:
    sid, remaining = map(int, row.split('\t'))
    assert remaining > 0
else:
    slot = call(admin, '/admin/schedule', dict(doctorId=1, workDate=day, period=3,
        startTime='18:00:00', endTime='23:59:00', totalNum=4, status=1))
    sid, remaining = slot['id'], slot['remainNum']
pet = call(owner, '/client/pet', dict(name='演示猫', species='猫', gender=1))
fixture = dict(day=day, scheduleId=sid, remain=remaining, petId=pet['id'], pet='演示猫')
OUT.mkdir(exist_ok=True)
(OUT/'demo.json').write_text(json.dumps(fixture, ensure_ascii=False), encoding='utf-8')
print(json.dumps(fixture, ensure_ascii=False))
