import globals from 'globals';

const rules = {'no-undef':'error','no-unused-vars':['error',{args:'none',caughtErrors:'none'}],eqeqeq:['error','smart']};

export default [
  {files:['src/**/*.js','views/app.js','views/app/*.js'],languageOptions:{ecmaVersion:2023,sourceType:'module',globals:globals.browser},rules},
  // theme.js runs in the page's head and diagram-renderer.js in its own document, so they stay classic scripts.
  {files:['views/*.js'],ignores:['views/app.js'],languageOptions:{ecmaVersion:2023,sourceType:'script',globals:{...globals.browser,DOMPurify:'readonly'}},rules},
  {files:['tests/**/*.js'],languageOptions:{ecmaVersion:2023,sourceType:'module',globals:globals.node},rules},
  {files:['tests/**/*.cjs'],languageOptions:{ecmaVersion:2023,sourceType:'commonjs',globals:globals.node},rules},
];
