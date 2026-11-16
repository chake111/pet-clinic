/**
 * 病历正文块提取，后台打印页与用户端详情页共用。
 * 字段顺序按医生书写顺序排：主诉 → 体格检查 → 诊断 → 处方 → 处置 → 医嘱；
 * 诊断结论是全篇重点，带 strong 让页面抬高显示；空字段直接过滤掉。
 */
export function medicalRecordBlocks(record) {
  if (!record) return []
  return [
    { label: '主诉', value: record.chiefComplaint },
    { label: '体格检查', value: record.physicalExam },
    { label: '诊断结论', value: record.diagnosis, strong: true },
    { label: '处方 / 用药建议', value: record.prescription },
    { label: '处置措施', value: record.treatment },
    { label: '医嘱', value: record.advice }
  ].filter((b) => b.value)
}
