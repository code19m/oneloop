/* Attachment and Knowledge views. HTML runs only in an opaque-origin sandbox; originals stay unchanged. */
(() => {
  const remote=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password;}catch{return false;}};
  const embedded=value=>/^data:image\/(png|jpe?g|gif|webp|avif);base64,/i.test(value||'');
  function shell(host,kind,text,truncated){
    UIHTML(host,`<div class="html-preview-tools"><div class="seg" role="group" aria-label="${kind} preview mode"><button class="on" aria-pressed="true" data-view-preview>Preview</button><button aria-pressed="false" data-view-source>Source</button></div></div>${truncated?'<p class="access-note">'+(kind==='HTML'?'Source truncated to 200,000 characters.':'Preview truncated to 200 KB.')+' Download the full file.</p>':''}<div class="document-preview"></div><pre class="html-source" tabindex="0" hidden></pre>`);
    const tools=host.querySelector('.html-preview-tools');host.closest('.file-dialog')?.querySelector('.file-tools')?.append(tools);
    const view=host.querySelector('.document-preview'),source=host.querySelector('.html-source');source.textContent=text;
    let onMode=()=>{};
    const mode=rendered=>{if(view.hidden===!rendered)return;onMode(rendered);view.hidden=!rendered;source.hidden=rendered;UIMotion.fade(rendered?view:source);for(const [key,on]of [['preview',rendered],['source',!rendered]]){const button=tools.querySelector('[data-view-'+key+']');button.classList.toggle('on',on);button.setAttribute('aria-pressed',String(on));}};
    tools.querySelector('[data-view-preview]').onclick=()=>mode(true);tools.querySelector('[data-view-source]').onclick=()=>mode(false);
    return {view,tools,onMode(callback){onMode=callback;}};
  }
  const assetBase=new URL('../',document.currentScript?.src||new URL('/views/file-views.js',location.href));
  const mermaidURL=new URL('vendor/mermaid/mermaid.min.js',assetBase);
  const markdownAssets=new Map();
  /** @type {Promise<void>|null} */
  let markdownLoad=null;
  let markdownReady=['marked','DOMPurify','markedFootnote','markedAlert'].every(name=>!!window[name]);
  /** @type {Promise<void>|null} */
  let mathLoad=null;
  /** @param {string} text */
  const needsHighlight=text=>/[`~]{3,}[^\S\n]*[\w+-]+|<code\b[^>]*\blanguage-/i.test(text);
  // Broad detection preserves nested fences, GitHub math and safe embedded code.
  /** @param {string} text */
  const needsMath=text=>/\$|(?:`{3,}|~{3,})\s*math\b/.test(text);
  const previewWindow=/** @type {Window & {hljs?:unknown,katex?:unknown,markedKatex?:unknown}} */(window);
  /** @param {string} text */
  const readyFor=text=>markdownReady&&(!needsHighlight(text)||!!previewWindow.hljs)&&(!needsMath(text)||!!previewWindow.katex&&!!previewWindow.markedKatex);

  function loadMarkdownAsset(path,globalName){
    if(globalName&&window[globalName])return Promise.resolve();
    if(markdownAssets.has(path))return markdownAssets.get(path);
    const promise=new Promise((resolve,reject)=>{
      const style=path.endsWith('.css'),element=document.createElement(style?'link':'script');
      const url=new URL(path,assetBase).href;
      if(style){element.rel='stylesheet';element.href=url;}else{element.src=url;element.async=false;}
      const fail=()=>{clearTimeout(timer);element.onload=element.onerror=null;element.remove();reject(new Error('Markdown renderer unavailable'));};
      const timer=setTimeout(fail,30_000);
      element.onload=()=>{
        if(globalName&&!window[globalName]){fail();return;}
        clearTimeout(timer);element.onload=element.onerror=null;resolve();
      };
      element.onerror=fail;document.head.append(element);
    });
    markdownAssets.set(path,promise);
    promise.catch(()=>markdownAssets.delete(path));
    return promise;
  }

  /** @param {string} text */
  function loadMarkdown(text){
    if(!markdownReady&&!markdownLoad)markdownLoad=Promise.all([
      loadMarkdownAsset('vendor/marked/marked.js','marked'),
      loadMarkdownAsset('vendor/dompurify/purify.js','DOMPurify'),
      loadMarkdownAsset('styles/markdown-preview.css'),
    ]).then(()=>Promise.all([
      loadMarkdownAsset('vendor/marked-footnote/index.js','markedFootnote'),
      loadMarkdownAsset('vendor/marked-alert/index.js','markedAlert'),
    ])).then(()=>{markdownReady=true;}).catch(error=>{markdownLoad=null;throw error;});
    const groups=[markdownLoad];
    if(needsHighlight(text))groups.push(loadMarkdownAsset('vendor/cdn-assets/highlight.js','hljs'));
    if(needsMath(text)){
      if(!mathLoad)mathLoad=Promise.all([
        markdownLoad,
        loadMarkdownAsset('vendor/katex/katex.min.js','katex'),
        loadMarkdownAsset('vendor/katex/katex.min.css'),
      ]).then(()=>loadMarkdownAsset('vendor/marked-katex-extension/index.js','markedKatex')).catch(error=>{mathLoad=null;throw error;});
      groups.push(mathLoad);
    }
    return Promise.all(groups);
  }
  let mermaidLoad,diagramSequence=0,diagramQueue=Promise.resolve();
  function loadMermaid(){
    if(window.mermaid)return Promise.resolve(window.mermaid);
    if(!mermaidLoad)mermaidLoad=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=mermaidURL.href;script.onload=()=>window.mermaid?resolve(window.mermaid):reject(new Error('Diagram renderer unavailable'));script.onerror=()=>{script.remove();mermaidLoad=null;reject(new Error('Diagram renderer unavailable'));};document.head.append(script);});
    return mermaidLoad;
  }
  function renderDiagrams(article,context){
    for(const code of article.querySelectorAll('pre code.language-mermaid')){
      const source=code.textContent,pre=code.parentElement,figure=document.createElement('figure');figure.className='markdown-diagram';figure.setAttribute('aria-busy','true');
      const status=document.createElement('span');status.className='markdown-diagram-status';status.textContent='Rendering diagram…';figure.append(status);pre.replaceWith(figure);
      const fallback=message=>{figure.removeAttribute('aria-busy');status.textContent=message;figure.replaceChildren(status,pre);};
      if(source.length>50000){fallback('Diagram is too large to render. Source is shown below.');continue;}
      diagramQueue=diagramQueue.then(async()=>{
        if(!figure.isConnected)return;
        try{
          const mermaid=await loadMermaid();if(!figure.isConnected)return;
          mermaid.initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,maxTextSize:50000,maxEdges:500,theme:document.documentElement.dataset.theme==='dark'?'dark':'default',...context.diagramTheme?.(),flowchart:{htmlLabels:false},htmlLabels:false,
            secure:['secure','securityLevel','startOnLoad','maxTextSize','maxEdges','suppressErrorRendering','theme','themeCSS','themeVariables','htmlLabels','flowchart','fontFamily','dompurifyConfig']});
          const {svg}=await mermaid.render('attachment-diagram-'+(++diagramSequence),source);
          if(!figure.isConnected)return;
          // Display the generated SVG as an image: its CSS, links and scripts cannot affect the app.
          const clean=DOMPurify.sanitize(svg,{USE_PROFILES:{svg:true,svgFilters:true},FORBID_TAGS:['foreignObject','a','image'],FORBID_ATTR:['onload','onclick']});
          const picture=document.createElement('img');picture.alt='Mermaid diagram';const svgDoc=new DOMParser().parseFromString(clean,'image/svg+xml'),bounds=svgDoc.documentElement.getAttribute('viewBox')?.trim().split(/[ ,]+/).map(Number);if(bounds?.length===4&&bounds[2]>0&&bounds[3]>0){picture.width=Math.ceil(bounds[2]);picture.height=Math.ceil(bounds[3]);}picture.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(clean);figure.replaceChildren(picture);figure.removeAttribute('aria-busy');UIMotion.fade(figure);
        }catch{if(figure.isConnected)fallback('This diagram could not be rendered. Check its Mermaid syntax.');}
      });
    }
  }
  /**
   * Render Markdown. A Knowledge `context` resolves relative links and images
   * inside its folder and themes diagrams; attachments have no context.
   */
  function markdown(host,file,text,truncated,context={}){
    const ui=shell(host,'Markdown',text,truncated);ui.view.classList.add('markdown-scroll');ui.view.tabIndex=0;ui.view.setAttribute('aria-label','Rendered Markdown');
    if(readyFor(text)){renderMarkdown(ui,text,context);return;}
    const load=()=>{
      UIHTML(ui.view,'<p class="preview-unavailable" role="status">Loading Markdown preview…</p>');
      const active=()=>ui.view.isConnected&&!ui.view.closest('[inert],[data-motion-exiting]');
      loadMarkdown(text).then(()=>{if(active())renderMarkdown(ui,text,context);}).catch(()=>{
        if(!active())return;
        const notice=document.createElement('div');notice.className='preview-unavailable';notice.setAttribute('role','alert');
        const copy=document.createElement('p');copy.textContent='Markdown preview could not load. Use Source or download the file.';
        const retry=document.createElement('button');retry.type='button';retry.className='btn quiet';retry.textContent='Retry';retry.onclick=load;
        notice.append(copy,retry);ui.view.replaceChildren(notice);
      });
    };
    load();
  }
  function renderMarkdown(ui,text,context){
    if(!window.marked||!window.DOMPurify){UIHTML(ui.view,'<p class="preview-unavailable">Markdown preview could not load. Use Source or download the file.</p>');return;}
    const maths=[];
    const mathPlaceholder=token=>{const index=maths.push({text:token.text,display:!!token.displayMode})-1;return `<${token.displayMode?'div':'span'} data-md-math="${index}"></${token.displayMode?'div':'span'}>`;};
    const parser=new marked.Marked({gfm:true,breaks:false,async:false});
    if(window.markedFootnote)parser.use(markedFootnote());
    if(window.markedAlert)parser.use(markedAlert());
    if(window.markedKatex&&window.katex){
      const math=markedKatex();math.extensions.forEach(extension=>extension.renderer=mathPlaceholder);parser.use(math);
      parser.use({extensions:[{name:'githubInlineMath',level:'inline',start:src=>src.indexOf('$`'),tokenizer(src){const match=/^\$`([^\n]+?)`\$/.exec(src);if(match)return {type:'githubInlineMath',raw:match[0],text:match[1],displayMode:false};},renderer:mathPlaceholder}],renderer:{code(token){if(token.lang?.trim()==='math')return mathPlaceholder({text:token.text,displayMode:true});return false;}}});
    }
    let parsed;
    try{parsed=parser.parse(text.replace(/^\uFEFF/,''),{gfm:true,breaks:false,async:false});}catch{UIHTML(ui.view,'<p class="preview-unavailable">This Markdown could not be rendered. Use Source or download the file.</p>');return;}
    const render=()=>{
      if(!text.trim()){UIHTML(ui.view,'<p class="preview-unavailable">This file is empty.</p>');return;}
      const scroll=ui.view.scrollTop;
      const fragment=DOMPurify.sanitize(parsed,{RETURN_DOM_FRAGMENT:true,USE_PROFILES:{html:true},ADD_TAGS:['svg','path'],ALLOW_DATA_ATTR:false,ADD_ATTR:['viewBox','d','data-md-math','data-footnote-ref','data-footnote-backref','data-footnotes'],FORBID_TAGS:['style','form','button','textarea','select','audio','video','source','picture','iframe','object','embed'],FORBID_ATTR:['tabindex','style','name','srcset','autofocus','form','formaction','popover'],SANITIZE_NAMED_PROPS:true});
      fragment.querySelectorAll('*').forEach(el=>[...el.attributes].forEach(attr=>{if(attr.name.startsWith('data-oneloop-'))el.removeAttribute(attr.name);}));
      // Keep renderer classes, never application chrome supplied by an upload.
      fragment.querySelectorAll('[class]').forEach(el=>{
        const classes=[...el.classList].filter(name=>/^(?:language-[\w-]+|hljs[\w-]*|markdown-alert[\w-]*|task-list-[\w-]+|footnotes|sr-only|octicon[\w-]*)$/.test(name));
        if(classes.length)el.setAttribute('class',classes.join(' '));else el.removeAttribute('class');
      });
      const slugs=new Map(),used=new Set();
      fragment.querySelectorAll('[id]').forEach(el=>{const id=el.id.replace(/^user-content-/,'');if(id.startsWith('footnote-'))el.id='md-'+id;else el.removeAttribute('id');});
      fragment.querySelectorAll('[aria-describedby]').forEach(el=>{const ids=el.getAttribute('aria-describedby').split(/\s+/).filter(id=>id.startsWith('footnote-')).map(id=>'md-'+id);if(ids.length)el.setAttribute('aria-describedby',ids.join(' '));else el.removeAttribute('aria-describedby');});
      fragment.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(heading=>{if(heading.id)return;const base=heading.textContent.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu,'').replace(/\s/g,'-');let n=slugs.get(base)||0,id;do{id='md-'+base+(n?'-'+n:'');n++;}while(used.has(id));slugs.set(base,n);used.add(id);heading.id=id;});
      fragment.querySelectorAll('input').forEach(el=>{if(el.type!=='checkbox'){el.remove();return;}el.disabled=true;el.classList.add('task-list-item-checkbox');el.closest('li')?.classList.add('task-list-item');});
      fragment.querySelectorAll('a').forEach(link=>{if(link.namespaceURI!=='http://www.w3.org/1999/xhtml'){link.replaceWith(...link.childNodes);return;}const href=link.getAttribute('href')||'';if(href.startsWith('#')){link.href='#md-'+href.slice(1);link.removeAttribute('target');}else if(/^(https?:\/\/|mailto:)/i.test(href)){link.setAttribute('target','_blank');link.setAttribute('rel','noopener noreferrer');}else{const resolved=context.resolveLink?.(href);if(typeof resolved==='string'&&resolved.startsWith('#/')){link.setAttribute('href',resolved);link.removeAttribute('target');}else{link.removeAttribute('href');link.title='Relative links need the original project files.';}}});
      fragment.querySelectorAll('img').forEach(img=>{const src=img.getAttribute('src')||'',local=context.resolveImage?.(src);if(typeof local==='string'&&local.startsWith('/api/')){img.setAttribute('src',local);img.loading='lazy';img.onerror=()=>{const label=document.createElement('span');label.className='markdown-image-placeholder';label.textContent=img.alt||'Image unavailable';img.replaceWith(label);};}else if(embedded(src)||remote(src)){img.referrerPolicy='no-referrer';img.loading='lazy';img.onerror=()=>{const label=document.createElement('span');label.className='markdown-image-placeholder';label.textContent=img.alt||'Image unavailable';img.replaceWith(label);};}else{const label=document.createElement('span');label.className='markdown-image-placeholder';label.textContent='Image: '+(img.alt||'attachment')+' (unavailable)';img.replaceWith(label);}});
      fragment.querySelectorAll('pre code').forEach(code=>{const lang=[...code.classList].find(c=>c.startsWith('language-'))?.slice(9);if(window.hljs&&lang&&hljs.getLanguage(lang)){try{UIHTML(code,hljs.highlight(code.textContent,{language:lang,ignoreIllegals:true}).value);code.classList.add('hljs');}catch{}}});
      const article=document.createElement('article');article.className='markdown-body';article.append(fragment);ui.view.replaceChildren(article);ui.view.scrollTop=scroll;
      article.querySelectorAll('[data-md-math]').forEach(el=>{const expression=maths[Number(el.dataset.mdMath)];el.removeAttribute('data-md-math');if(!expression||!window.katex)return;el.className=expression.display?'markdown-math-block':'markdown-math-inline';if(expression.text.length>10000){el.textContent=expression.text;return;}try{katex.render(expression.text,el,{displayMode:expression.display,throwOnError:false,trust:false,maxExpand:1000,maxSize:20,strict:'ignore',output:'htmlAndMathml',macros:{}});}catch{el.textContent=expression.text;}});
      renderDiagrams(article,context);
    };
    ui.view.onclick=event=>{const link=event.target.closest('a');if(!link)return;const href=link.getAttribute('href');if(href?.startsWith('#md-')){event.preventDefault();const target=[...ui.view.querySelectorAll('[id]')].find(el=>el.id===href.slice(1));if(target){ui.view.scrollTo({top:ui.view.scrollTop+target.getBoundingClientRect().top-ui.view.getBoundingClientRect().top-16,behavior:UIMotion.reduced()?'auto':'smooth'});target.tabIndex=-1;target.focus({preventScroll:true});}}};
    render();
  }
  function html(host,file,text){
    const ui=shell(host,'HTML',text.slice(0,200000),file.size>200000||text.length>200000);
    // Preserve existing selectors used by callers and checks.
    ui.tools.querySelector('[data-view-preview]').setAttribute('data-html-rendered','');ui.tools.querySelector('[data-view-source]').setAttribute('data-html-source','');
    const restart=document.createElement('button');restart.className='btn icon';restart.type='button';restart.title='Reload preview';restart.setAttribute('aria-label','Reload preview');UIHTML(restart,'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7"/></svg>');restart.setAttribute('data-html-restart','');ui.tools.append(restart);
    /** @type {string|undefined} */
    let content;
    const buildSrcdoc=()=>{
      if(content!==undefined)return content;
      // Uploaded HTML keeps its own handlers for execution only inside the sandbox.
      const doc=document.implementation.createHTMLDocument('');doc.documentElement.innerHTML=text;
      doc.querySelectorAll('iframe,frame,frameset,object,embed,base,meta[http-equiv],portal,fencedframe').forEach(el=>el.remove());
      // Scripts and handlers intentionally run inside the frame, never in the app document.
      const policy="default-src 'none'; script-src 'unsafe-inline' https:; connect-src 'none'; img-src data: blob: https:; style-src 'unsafe-inline' https:; font-src data: https:; media-src 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
      const meta=document.createElement('meta');meta.httpEquiv='Content-Security-Policy';meta.content=policy;doc.head.prepend(meta);
      const referrer=document.createElement('meta');referrer.name='referrer';referrer.content='no-referrer';doc.head.prepend(referrer);
      if(!doc.querySelector('meta[name=viewport]')){const viewport=document.createElement('meta');viewport.name='viewport';viewport.content='width=device-width, initial-scale=1';doc.head.prepend(viewport);}
      const charset=document.createElement('meta');charset.setAttribute('charset','utf-8');doc.head.prepend(charset);
      const defaults=document.createElement('style');defaults.textContent='html{color-scheme:light}body{margin:20px;font:16px/1.5 system-ui;background:#fff;color:#202020;overflow-wrap:anywhere}img{max-width:100%}';meta.after(defaults);
      const escapeKey=document.createElement('script');escapeKey.textContent="document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();parent.postMessage({type:'oneloop-preview-escape'},'*');}},true);";defaults.after(escapeKey);
      return content='<!doctype html>'+doc.documentElement.outerHTML;
    };
    const start=()=>{
      const frame=document.createElement('iframe');frame.className='html-preview';frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; payment 'none'");frame.title=file.name.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'')+' preview';frame.tabIndex=0;
      if(file.htmlPreviewUrl){const url=new URL(file.htmlPreviewUrl,location.href);url.searchParams.set('reload',String(Date.now()));frame.src=url.href;}else{frame.setAttribute('credentialless','');frame.srcdoc=buildSrcdoc();}ui.view.replaceChildren(frame);
    };
    ui.onMode(rendered=>{restart.hidden=!rendered;if(rendered){if(!ui.view.firstChild)start();}else ui.view.replaceChildren();});
    restart.onclick=start;start();
  }

  // The frame can request dismissal only. Never expose app data or commands over messages.
  window.addEventListener('message',event=>{const frame=document.querySelector('.file-dialog .html-preview');if(frame&&event.source===frame.contentWindow&&event.data?.type==='oneloop-preview-escape')document.querySelector('[data-file-close]')?.click();});
  /** Plain text, with JSON indented when the whole file is present. */
  function text(host,file,value,truncated){
    host.replaceChildren();let shown=value;
    if(String(file.name).toLowerCase().endsWith('.json')&&!truncated){try{shown=JSON.stringify(JSON.parse(value),null,2);}catch{}}
    const pre=document.createElement('pre');pre.className='file-source-text';pre.tabIndex=0;pre.textContent=shown;host.append(pre);
    if(truncated){const note=document.createElement('p');note.className='access-note';note.textContent='Preview truncated to 200 KB. Download the full file.';host.prepend(note);}
  }
  window.FileViews={markdown,html,text};
})();
