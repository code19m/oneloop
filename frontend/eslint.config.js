import globals from 'globals';

const languageOptions = {ecmaVersion:2023,globals:{...globals.browser,...Object.fromEntries(['Recovery','DOMPurify'].map(name=>[name,'readonly']))}};
const rules = {'no-undef':'error','no-unused-vars':['error',{args:'none',caughtErrors:'none'}],eqeqeq:['error','smart']};

export default [
  {files:['src/**/*.js','views/app.js','views/app/*.js'],languageOptions:{...languageOptions,sourceType:'module'},rules},
  // theme.js runs in the page's head and diagram-renderer.js in its own document, so they stay classic scripts.
  {files:['views/*.js'],ignores:['views/app.js'],languageOptions:{...languageOptions,sourceType:'script'},rules},
];
