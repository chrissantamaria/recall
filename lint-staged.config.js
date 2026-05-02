/* eslint-disable no-dupe-keys */
export default {
  '*.{ts,tsx}': () => 'pnpm run typecheck',
  '*': 'eslint --cache --fix',
  '*': 'prettier --write --ignore-unknown',
};
