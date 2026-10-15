import globals from 'globals';

const languageOptions = {ecmaVersion:2023,globals:{...globals.browser,...Object.fromEntries(['FileViews','Collab','Recovery','UIHTML','UIEscape','UIAction','UIMotion','DOMPurify','hljs','katex','marked','markedAlert','markedFootnote','markedKatex'].map(name=>[name,'readonly']))}};
const rules = {'no-undef':'error','no-unused-vars':['error',{args:'none',caughtErrors:'none'}],eqeqeq:['error','smart']};

export default [
  {files:['src/**/*.js','views/app.js','views/app/*.js'],languageOptions:{...languageOptions,sourceType:'module'},rules},
  // The other views are classic scripts that index.html loads before app.js.
  {files:['views/*.js'],ignores:['views/app.js'],languageOptions:{...languageOptions,sourceType:'script'},rules},
];
