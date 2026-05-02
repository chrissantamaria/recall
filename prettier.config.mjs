/** @type {import("@ianvs/prettier-plugin-sort-imports").PrettierConfig} */
const config = {
  plugins: ['@ianvs/prettier-plugin-sort-imports'],
  singleQuote: true,
  importOrder: [
    '<THIRD_PARTY_MODULES>',
    '',
    // Absolute imports, starting with `~/`
    '^~/(.*)$',
    '',
    // Parent imports. Put `..` last.
    '^\\.\\.(?!/?$)',
    '^\\.\\./?$',
    // Other relative imports. Put same-folder imports and `.` last.
    '^\\./(?=.*/)(?!/?$)',
    '^\\.(?!/?$)',
    '^\\./?$',
  ],
};

export default config;
