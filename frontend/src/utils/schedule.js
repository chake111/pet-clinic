/**
 * 号源展示的共用纯函数（确认挂号页、医生详情页共用）。
 */

/** 按就诊日期归组，保持日期首次出现的先后与组内原序（模板里一组一个横滚条） */
export function groupSlotsByDate(slots) {
  const map = new Map()
  for (const s of slots) {
    if (!map.has(s.workDate)) map.set(s.workDate, [])
    map.get(s.workDate).push(s)
  }
  return [...map.entries()].map(([date, list]) => ({ date, list }))
}

/**
 * 本地当天日期与当前 HH:mm（补零）。date 可注入便于测试，缺省取当前时刻。
 *
 * 契约动机: 提交兜底必须按需取实时值、不能用 60 秒时钟的缓存判断——缓存时间会放行已过时段。
 */
export function localNow(date = new Date()) {
  return {
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    hhmm: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }
}
