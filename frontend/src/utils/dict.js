/**
 * 与数据库注释一一对应的枚举文案。
 * 集中放这里，是为了让"改口径"只改一处；tag 决定状态胶囊的语义色，
 * 取值对齐 docs/design.md 的 status-chip：ongoing 蓝 / success 绿 / warning 橙 /
 * danger 红 / terminated 灰。品牌红（Rausch）不在这套语义里，它只表示"动作"。
 */
export const APPT_STATUS = {
  0: { text: '待接诊', tag: 'warning' },
  1: { text: '就诊中', tag: 'ongoing' },
  2: { text: '已完成', tag: 'success' },
  3: { text: '已取消', tag: 'terminated' },
  4: { text: '未到诊', tag: 'terminated' }
}

export const PAY_STATUS = {
  0: { text: '未支付', tag: 'warning' },
  1: { text: '已支付', tag: 'success' },
  2: { text: '已退款', tag: 'terminated' }
}

export const CONSULT_TYPE = { 1: '在线图文问诊', 2: '到院门诊' }

export const PERIOD = { 1: '上午', 2: '下午', 3: '夜间' }

export const SESSION_STATUS = {
  0: { text: '待接诊', tag: 'warning' },
  1: { text: '进行中', tag: 'ongoing' },
  2: { text: '已结束', tag: 'terminated' }
}

/** 管理员处置（与 SESSION_STATUS 正交的治理轴；非 0 时参与方不可见该会话） */
export const MODERATE_STATUS = {
  0: { text: '未处置', tag: 'success' },
  1: { text: '无效关闭', tag: 'warning' },
  2: { text: '违规屏蔽', tag: 'danger' }
}

/** 单条消息的屏蔽状态（管理员审计视图标注用） */
export const CONSULT_MSG_STATUS = {
  0: { text: '正常', tag: 'success' },
  1: { text: '已屏蔽', tag: 'danger' }
}

export const SPECIES = ['猫', '狗', '兔', '鸟', '爬行', '其他']
export const PET_GENDER = { 0: '未知', 1: '公', 2: '母' }
export const USER_GENDER = { 0: '保密', 1: '男', 2: '女' }
export const VACCINE = {
  0: { text: '未接种', tag: 'warning' },
  1: { text: '部分接种', tag: 'warning' },
  2: { text: '已完成', tag: 'success' }
}
export const DEWORM = {
  0: { text: '待做', tag: 'warning' },
  1: { text: '已做', tag: 'success' }
}

export const WORK_STATUS = { 0: { text: '停诊', tag: 'danger' }, 1: { text: '正常', tag: 'success' } }
export const ONLINE = { 0: '离线', 1: '在线' }

export const REVIEW_STATUS = { 0: { text: '已隐藏', tag: 'terminated' }, 1: { text: '显示中', tag: 'success' } }
export const NOTICE_TYPE = { 1: '公告', 2: '活动', 3: '养宠科普' }
export const NOTICE_STATUS = {
  0: { text: '草稿', tag: 'terminated' },
  1: { text: '已发布', tag: 'success' },
  2: { text: '已下架', tag: 'warning' }
}

export const ACCOUNT_STATUS = { 0: { text: '禁用', tag: 'danger' }, 1: { text: '正常', tag: 'success' } }
export const CANCEL_BY = { USER: '用户取消', DOCTOR: '医生取消', ADMIN: '管理员取消', SYSTEM: '系统超时取消' }

/** 预约状态的可选项，下拉框直接用它，避免每个页面各写一份 */
export const options = (map) =>
  Object.entries(map).map(([k, v]) => ({ value: Number(k), label: typeof v === 'string' ? v : v.text }))

export const text = (map, key, fallback = '—') => map[key]?.text ?? map[key] ?? fallback

/** 取枚举里配好的状态色 tone，省去页面里按文案反推；没配 tag 的当内容标签处理 */
export const tagType = (map, key) => map[key]?.tag ?? 'plain'
