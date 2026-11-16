const chineseSubject = {
  rules: {
    'subject-chinese': (parsed) => {
      const subject = parsed.subject || ''
      return [
        /[\u4e00-\u9fff]/.test(subject),
        '提交说明（冒号后）必须包含中文',
      ]
    },
  },
}

module.exports = {
  extends: ['@commitlint/config-conventional'],
  plugins: [chineseSubject],
  rules: {
    'subject-chinese': [2, 'always'],
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
    // 只约束主题；正文保留原有英文说明和较长单行，不做行长限制
    'body-max-line-length': [0],
  },
}