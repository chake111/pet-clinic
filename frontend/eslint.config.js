// 前端静态检查：Vue 3 + 浏览器环境，只开"会真出错"的规则，不引入格式化口径。
// 运行：npm run lint（加 --fix 可自动修可修项）
import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import globals from 'globals'

export default [
  { ignores: ['dist/**', 'node_modules/**', '.oil-ui/**'] },
  js.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.{js,mjs,vue}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser }
    },
    rules: {
      // 页面组件按业务命名（Home、Booking），不强制多词
      'vue/multi-word-component-names': 'off',
      // 允许为文档完整性保留未使用参数，但未使用变量仍是错误；
      // ignoreRestSiblings 让 `const { confirm, ...payload } = form` 这类"剔除字段"的写法不必改名
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      // 与本项目既有写法一致：单文件组件允许 <style scoped>
      'vue/valid-v-slot': 'error'
    }
  },
  {
    // 工具脚本与测试跑在 Node 里，不是浏览器
    files: ['tools/**/*.mjs', 'tests/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } }
  }
]
