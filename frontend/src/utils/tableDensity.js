/**
 * 后台表格的密度阶梯：按"容器实际可用宽度"决定显示哪些列。
 *
 * 为什么不用 window.innerWidth：后台可用宽度 = 视口 − 侧栏 − 主区内边距 − 卡片内边距，
 * 而侧栏在窄屏会自动折叠，这条关系不是单调的（900 附近可用宽度会跳一下）。
 * 用 innerWidth 写死阈值，边界上必然差几十像素——上一版就是这样在 1200 和 1024 各溢出 66px。
 *
 * 列宽与 Doctor.vue 模板里的 width / min-width 一一对应，改一处要同步另一处；
 * tests/style-guard.test.mjs 会比对两者，漏改会直接失败。
 */

/** 医生表各列宽度，顺序即显示顺序。actions 必须是最后一列（固定在右侧）。 */
export const DOCTOR_COLUMNS = [
  { key: 'doctor', label: '医生', width: 160 },
  { key: 'department', label: '科室', width: 96 },
  { key: 'specialty', label: '擅长', width: 168 },
  { key: 'experience', label: '经验', width: 72 },
  { key: 'fee', label: '问诊费', width: 86 },
  { key: 'rating', label: '评分', width: 92 },
  { key: 'appointments', label: '接诊', width: 72 },
  { key: 'online', label: '在线', width: 76 },
  { key: 'status', label: '状态', width: 80 },
  { key: 'actions', label: '操作', width: 210 }
]

/** 阶梯从宽到窄，drop 是累计隐藏的列；阈值是"这一档至少要有的容器宽度"。 */
export const DOCTOR_LADDER = [
  { min: 1112, drop: [] },
  { min: 968, drop: ['experience', 'appointments'] },
  { min: 790, drop: ['experience', 'appointments', 'fee', 'rating'] },
  { min: 714, drop: ['experience', 'appointments', 'fee', 'rating', 'online'] },
  { min: 618, drop: ['experience', 'appointments', 'fee', 'rating', 'online', 'department'] },
  { min: 0, drop: ['experience', 'appointments', 'fee', 'rating', 'online', 'department', 'specialty'] }
]

/** 状态与操作两列任何宽度下都保留：前者决定能不能接诊，后者是唯一出口。 */
const ALWAYS_VISIBLE = new Set(['doctor', 'status', 'actions'])

/** 当前容器宽度下应当隐藏的列（返回 Set，模板里直接 has）。 */
export function hiddenColumns(width, ladder = DOCTOR_LADDER) {
  const tier = ladder.find((step) => width >= step.min) ?? ladder[ladder.length - 1]
  return new Set(tier.drop.filter((key) => !ALWAYS_VISIBLE.has(key)))
}

/** 当前宽度下可见列的宽度合计。 */
export function visibleWidth(width, columns = DOCTOR_COLUMNS, ladder = DOCTOR_LADDER) {
  const hidden = hiddenColumns(width, ladder)
  return columns.reduce((sum, column) => sum + (hidden.has(column.key) ? 0 : column.width), 0)
}
