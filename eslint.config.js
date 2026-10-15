import tseslint from 'typescript-eslint'

// Типовой линт: ловит объект в строке ([object Object]), any и небезопасные значения.
export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'test-results', 'packs', 'public', 'scripts', 'e2e', '*.config.*', 'commitStamp.ts', 'src/ui/airStatus.tsx' /* не в проекте: импорт берёт airStatus.ts */] },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [tseslint.configs.base],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true, allowNullish: false }],
      '@typescript-eslint/restrict-plus-operands': 'error',
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
    },
  },
  {
    // В тестах JSON.parse и матчеры expect.* дают any по своей природе; строки по-прежнему строгие.
    files: ['src/**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
)
