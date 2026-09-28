import globals from 'globals';

export default [{
  files:['src/**/*.js','views/*.js'],
  languageOptions:{ecmaVersion:2023,sourceType:'module',globals:{...globals.browser,...Object.fromEntries(['FileViews','Activity','Collab','Recovery','UIHTML','UIEscape','UIArg','UIMotion','sha256','DOMPurify','hljs','katex','marked','markedAlert','markedFootnote','markedKatex'].map(name=>[name,'readonly']))}},
  rules:{'no-undef':'error','no-unused-vars':['error',{args:'none',caughtErrors:'none'}],eqeqeq:['error','smart']},
}];
