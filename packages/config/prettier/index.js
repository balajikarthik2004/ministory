/** Shared Prettier configuration. Re-exported by the root .prettierrc.js. */
export const prettierConfig = {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  arrowParens: 'always',
  endOfLine: 'lf',
  bracketSpacing: true,
  overrides: [
    {
      files: ['*.md', '*.yaml', '*.yml'],
      options: { printWidth: 80, proseWrap: 'preserve' },
    },
    {
      files: ['*.json'],
      options: { printWidth: 80 },
    },
  ],
};

export default prettierConfig;
