/* Attachment and Knowledge views. HTML previews show in an opaque-origin sandbox without scripts; originals stay unchanged. */
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
  const rendererURL=new URL('views/diagram-renderer.html',assetBase);
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
  // Mermaid draws in its own off-screen document: it writes inline styles and
  // HTML strings that this page's security policy refuses.
  let renderer=null,diagramSequence=0,diagramQueue=Promise.resolve();
  function diagramRenderer(){
    if(!renderer)renderer=new Promise((resolve,reject)=>{
      const frame=document.createElement('iframe');frame.className='diagram-renderer';frame.title='Diagram renderer';frame.tabIndex=-1;frame.inert=true;frame.setAttribute('aria-hidden','true');
      const fail=()=>{clearTimeout(timer);frame.remove();renderer=null;reject(new Error('Diagram renderer unavailable'));};
      const timer=setTimeout(fail,30_000);
      frame.addEventListener('load',()=>{const render=frame.contentWindow?.renderDiagram;if(typeof render!=='function'){fail();return;}clearTimeout(timer);resolve(render);},{once:true});
      frame.addEventListener('error',fail,{once:true});
      frame.src=rendererURL.href;document.body.append(frame);
    });
    return renderer;
  }
  // What each drawn diagram was drawn from, so a new theme can draw it again.
  const diagramSources=new WeakMap();
  /**
   * Draw one diagram into its figure, in the current theme. A first drawing
   * that fails shows the source; a new drawing that fails keeps the old one.
   */
  function drawDiagram(figure,source,context,fallback=null){
    diagramQueue=diagramQueue.then(async()=>{
      if(!figure.isConnected)return;
      try{
        const render=await diagramRenderer();if(!figure.isConnected)return;
        const drawn=await render('attachment-diagram-'+(++diagramSequence),source,{startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,maxTextSize:50000,maxEdges:500,theme:document.documentElement.dataset.theme==='dark'?'dark':'default',...context.diagramTheme?.(),flowchart:{htmlLabels:false},htmlLabels:false,
          secure:['secure','securityLevel','startOnLoad','maxTextSize','maxEdges','suppressErrorRendering','theme','themeCSS','themeVariables','htmlLabels','flowchart','fontFamily','dompurifyConfig']});
        if(!figure.isConnected)return;
        // The renderer returns sanitized SVG, shown as an image.
        const picture=document.createElement('img');picture.alt='Mermaid diagram';if(drawn.width&&drawn.height){picture.width=drawn.width;picture.height=drawn.height;}picture.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(drawn.svg);figure.replaceChildren(picture);figure.removeAttribute('aria-busy');
        if(fallback)UIMotion.fade(figure);
        diagramSources.set(figure,{source,context});
      }catch{if(figure.isConnected&&fallback)fallback('This diagram could not be rendered. Check its Mermaid syntax.');}
    });
  }
  function renderDiagrams(article,context){
    for(const code of article.querySelectorAll('pre code.language-mermaid')){
      const source=code.textContent,pre=code.parentElement,figure=document.createElement('figure');figure.className='markdown-diagram';figure.setAttribute('aria-busy','true');
      const status=document.createElement('span');status.className='markdown-diagram-status';status.textContent='Rendering diagram…';figure.append(status);pre.replaceWith(figure);
      const fallback=message=>{figure.removeAttribute('aria-busy');status.textContent=message;figure.replaceChildren(status,pre);};
      if(source.length>50000){fallback('Diagram is too large to render. Source is shown below.');continue;}
      drawDiagram(figure,source,context,fallback);
    }
  }
  // Diagram colors are part of the image, so a theme change, also one that
  // follows the device under System, draws the diagrams on the page again.
  new MutationObserver((records)=>{
    if(records.every(record=>record.oldValue===document.documentElement.dataset.theme))return;
    for(const figure of document.querySelectorAll('figure.markdown-diagram')){const drawn=diagramSources.get(figure);if(drawn)drawDiagram(figure,drawn.source,drawn.context);}
  }).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme'],attributeOldValue:true});
  // Heading anchors follow src/knowledge/markdown.rs (inline_text, slug and
  // the headings of sections), so search hits and MCP sections name the
  // headings shown here. tests/support/fixtures/heading-anchors.json checks
  // both sides; change them together.
  const isSpace=c=>/^\p{White_Space}$/u.test(c),isPunctuation=c=>/^[\p{P}\p{S}]$/u.test(c);
  const trimSpace=value=>value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu,''),trimEndSpace=value=>value.replace(/\p{White_Space}+$/u,'');
  const slug=text=>text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc}\p{White_Space}-]/gu,'').replace(/\p{White_Space}/gu,'-');
  const ENTITIES={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'};
  /** A character reference at `start`, and its length. */
  function entity(chars,start){
    let end=-1;for(let at=start;at<Math.min(chars.length,start+34);at++)if(chars[at]===';'){end=at;break;}
    if(end<0)return null;
    const body=chars.slice(start+1,end).join('');let decoded;
    if(body.startsWith('#')){
      const hex=/^#[xX]/.test(body),digits=body.slice(hex?2:1);
      if(!(hex?/^[0-9a-fA-F]{1,6}$/:/^[0-9]{1,7}$/).test(digits))return null;
      const code=parseInt(digits,hex?16:10);decoded=code===0||code>0x10ffff||(code>=0xd800&&code<=0xdfff)?'\ufffd':String.fromCodePoint(code);
    }else if(Object.hasOwn(ENTITIES,body))decoded=ENTITIES[body];
    else return null;
    return [decoded,end-start+1];
  }
  const flanking=(next,previous)=>next!==null&&!isSpace(next)&&(!isPunctuation(next)||previous===null||isSpace(previous)||isPunctuation(previous));
  /** The text a reader sees in one line of inline Markdown. */
  function inlineText(value){
    const chars=Array.from(value),n=chars.length,memo=new Map();
    const next=(from,target)=>{const known=memo.get(target);if(known&&known.start<=from&&(known.found<0||known.found>=from))return known.found;let found=-1;for(let at=from;at<n;at++)if(chars[at]===target){found=at;break;}memo.set(target,{start:from,found});return found;};
    const pieces=[],linkEnds=new Map();let index=0;
    while(index<n){
      if(linkEnds.has(index)){const resume=linkEnds.get(index);linkEnds.delete(index);index=resume;continue;}
      const c=chars[index];
      if(c==='!'&&chars[index+1]==='['){index++;}
      else if(c==='['){const close=next(index+1,']');if(close>=0){let resume=close+1;if(chars[close+1]==='('||chars[close+1]==='['){const end=next(close+2,chars[close+1]==='('?')':']');resume=end<0?n:end+1;}linkEnds.set(close,resume);}else pieces.push(c);index++;}
      else if(c==='<'){const end=next(index+1,'>');if(end>=0&&/^[A-Za-z/]$/.test(chars[index+1]||'')){const inner=chars.slice(index+1,end).join('');if(inner.includes('@')||inner.includes('://'))pieces.push(...Array.from(inner));index=end+1;}else{pieces.push(c);index++;}}
      else if(c==='`')index++;
      else if(c==='~'&&chars[index+1]==='~')index+=2;
      else if(c==='\\'&&/^[!-/:-@[-`{-~]$/.test(chars[index+1]||'')){pieces.push(chars[index+1]);index+=2;}
      else if(c==='&'){const found=entity(chars,index);if(found){pieces.push(found[0]);index+=found[1];}else{pieces.push(c);index++;}}
      else if(c==='*'||c==='_'){
        let length=0;while(chars[index+length]===c)length++;
        const before=index>0?chars[index-1]:null,after=index+length<n?chars[index+length]:null,left=flanking(after,before),right=flanking(before,after);
        pieces.push({mark:c,left:length,open:c==='*'?left:left&&(!right||(before!==null&&isPunctuation(before))),close:c==='*'?right:right&&(!left||(after!==null&&isPunctuation(after)))});index+=length;
      }else{pieces.push(c);index++;}
    }
    // Emphasis marks go when they pair up, nearest opener first; others stay text.
    const openers={'*':[],'_':[]};
    pieces.forEach((piece,at)=>{
      if(typeof piece==='string')return;
      const same=openers[piece.mark],other=openers[piece.mark==='*'?'_':'*'];
      while(piece.close&&same.length){const opener=same[same.length-1],used=Math.min(pieces[opener].left,piece.left);if(!used)break;pieces[opener].left-=used;piece.left-=used;while(other.length&&other[other.length-1]>opener)other.pop();if(!pieces[opener].left)same.pop();}
      if(piece.open&&piece.left)same.push(at);
    });
    return pieces.map(piece=>typeof piece==='string'?piece:piece.mark.repeat(piece.left)).join('').split(/\p{White_Space}+/u).filter(Boolean).join(' ');
  }
  const indent=line=>{const trimmed=line.replace(/^ +/,'');return line.length-trimmed.length<=3?trimmed:null;};
  function opensFence(line){const trimmed=indent(line),marker=trimmed?.[0];if(marker!=='`'&&marker!=='~')return null;let length=0;while(trimmed[length]===marker)length++;return length>=3&&!(marker==='`'&&trimmed.slice(length).includes('`'))?{marker,length}:null;}
  function closesFence(line,fence){const trimmed=indent(line);if(trimmed===null)return false;let run=0;while(trimmed[run]===fence.marker)run++;return run>=fence.length&&!trimSpace(trimmed.slice(run));}
  function atxHeading(line){
    const trimmed=indent(line);if(trimmed===null)return null;
    let level=0;while(trimmed[level]==='#')level++;
    const rest=trimmed.slice(level);if(level<1||level>6||(rest&&!/^[ \t]/.test(rest)))return null;
    let text=trimSpace(rest);const withoutClosing=text.replace(/#+$/,'');
    if(withoutClosing.length!==text.length&&(!withoutClosing||/[ \t]$/.test(withoutClosing)))text=trimEndSpace(withoutClosing);
    return {level,text:inlineText(text)};
  }
  function setextLevel(line,nextLine){
    const text=indent(line);if(text===null||!trimSpace(text)||/^[#>\-*+|`~<]/.test(text)||(/^[0-9]/.test(text)&&text.includes('. ')))return 0;
    const underline=indent(nextLine);if(underline===null)return 0;const mark=trimEndSpace(underline);
    return /^=+$/.test(mark)?1:/^-+$/.test(mark)?2:0;
  }
  /** The headings the server indexes, each with its line and anchor. */
  function headingAnchors(source){
    const lines=source.replace(/^\uFEFF/,'').split('\n').map(line=>line.replace(/[\r\n]+$/,'')),headings=[];let fence=null;
    for(let index=0;index<lines.length;){
      const line=lines[index];
      if(fence){if(closesFence(line,fence))fence=null;index++;continue;}
      const opened=opensFence(line);if(opened){fence=opened;index++;continue;}
      const atx=atxHeading(line),setext=atx||index+1>=lines.length?0:setextLevel(line,lines[index+1]);
      const heading=atx||(setext?{level:setext,text:inlineText(trimSpace(line))}:null);
      if(heading)headings.push({...heading,line:index});
      index+=setext?2:1;
    }
    const occurrences=new Map(),used=new Set();
    for(const heading of headings){const base=slug(heading.text);let count=occurrences.get(base)||0,anchor;do{anchor=count?base+'-'+count:base;count++;}while(used.has(anchor));occurrences.set(base,count);used.add(anchor);heading.anchor=anchor;}
    return headings;
  }
  /**
   * Give rendered headings the server's anchors: top-level headings by their
   * line, headings the renderer nested by their text. Other headings get
   * anchors the server's never use.
   */
  function nameHeadings(fragment,source,tokens,nonce){
    const anchors=headingAnchors(source),byLine=new Map(anchors.map(anchor=>[anchor.line,anchor])),taken=new Set(anchors.map(anchor=>anchor.anchor));
    const tokenOf=new Map(),named=new Set();
    fragment.querySelectorAll('[data-md-heading]').forEach(el=>{const [mark,index]=el.getAttribute('data-md-heading').split('-');el.removeAttribute('data-md-heading');if(mark===nonce&&/^H[1-6]$/.test(el.tagName)&&tokens[Number(index)])tokenOf.set(el,tokens[Number(index)]);});
    const headings=[...fragment.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(heading=>!heading.id);
    const name=(heading,anchor)=>{heading.id='md-'+anchor.anchor;anchor.named=true;named.add(heading);};
    for(const heading of headings){const token=tokenOf.get(heading),anchor=token&&byLine.get(token.mdLine);if(anchor&&!anchor.named&&anchor.level===token.depth)name(heading,anchor);}
    const waiting=new Map();
    for(const heading of headings){const token=tokenOf.get(heading);if(named.has(heading)||!token)continue;const key=token.depth+'\n'+inlineText(token.text);if(!waiting.has(key))waiting.set(key,[]);waiting.get(key).push(heading);}
    for(const anchor of anchors){const heading=anchor.named?null:waiting.get(anchor.level+'\n'+anchor.text)?.shift();if(heading)name(heading,anchor);}
    const counts=new Map();
    for(const heading of headings){
      if(named.has(heading))continue;
      const token=tokenOf.get(heading),base=slug(token?inlineText(token.text):heading.textContent||'');
      let count=counts.get(base)||0,id;do{id=count?base+'-'+count:base;count++;}while(taken.has(id));counts.set(base,count);taken.add(id);heading.id='md-'+id;
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
    // Mark rendered headings with an unguessable value, so the ids can follow
    // the source's headings and uploaded HTML can't claim one.
    const nonce=Array.from(crypto.getRandomValues(new Uint32Array(2)),part=>part.toString(36)).join(''),headings=[];
    parser.use({
      hooks:{processAllTokens(tokens){let line=0;for(const token of tokens){if(token.type==='heading')token.mdLine=/^ {0,3}#{1,6}(?:[ \t\n]|$)/.test(token.raw)?line:line+token.raw.replace(/\n+$/,'').split('\n').length-2;line+=token.raw.split('\n').length-1;}return tokens;}},
      renderer:{heading(token){const index=headings.push(token)-1;return `<h${token.depth} data-md-heading="${nonce}-${index}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;}},
    });
    if(window.markedFootnote)parser.use(markedFootnote());
    if(window.markedAlert)parser.use(markedAlert());
    if(window.markedKatex&&window.katex){
      const math=markedKatex();math.extensions.forEach(extension=>extension.renderer=mathPlaceholder);parser.use(math);
      parser.use({extensions:[{name:'githubInlineMath',level:'inline',start:src=>src.indexOf('$`'),tokenizer(src){const match=/^\$`([^\n]+?)`\$/.exec(src);if(match)return {type:'githubInlineMath',raw:match[0],text:match[1],displayMode:false};},renderer:mathPlaceholder}],renderer:{code(token){if(token.lang?.trim()==='math')return mathPlaceholder({text:token.text,displayMode:true});return false;}}});
    }
    let parsed;
    const source=text.replace(/^\uFEFF/,'');
    try{parsed=parser.parse(source,{gfm:true,breaks:false,async:false});}catch{UIHTML(ui.view,'<p class="preview-unavailable">This Markdown could not be rendered. Use Source or download the file.</p>');return;}
    const render=()=>{
      if(!text.trim()){UIHTML(ui.view,'<p class="preview-unavailable">This file is empty.</p>');return;}
      const scroll=ui.view.scrollTop;
      const fragment=DOMPurify.sanitize(parsed,{RETURN_DOM_FRAGMENT:true,USE_PROFILES:{html:true},ADD_TAGS:['svg','path'],ALLOW_DATA_ATTR:false,ADD_ATTR:['viewBox','d','data-md-math','data-md-heading','data-footnote-ref','data-footnote-backref','data-footnotes'],FORBID_TAGS:['style','form','button','textarea','select','audio','video','source','picture','iframe','object','embed'],FORBID_ATTR:['tabindex','style','name','srcset','autofocus','form','formaction','popover'],SANITIZE_NAMED_PROPS:true});
      fragment.querySelectorAll('*').forEach(el=>[...el.attributes].forEach(attr=>{if(/^data-(?:action|args)\b/.test(attr.name))el.removeAttribute(attr.name);}));
      // Keep renderer classes, never application chrome supplied by an upload.
      fragment.querySelectorAll('[class]').forEach(el=>{
        const classes=[...el.classList].filter(name=>/^(?:language-[\w-]+|hljs[\w-]*|markdown-alert[\w-]*|task-list-[\w-]+|footnotes|sr-only|octicon[\w-]*)$/.test(name));
        if(classes.length)el.setAttribute('class',classes.join(' '));else el.removeAttribute('class');
      });
      fragment.querySelectorAll('[id]').forEach(el=>{const id=el.id.replace(/^user-content-/,'');if(id.startsWith('footnote-'))el.id='md-'+id;else el.removeAttribute('id');});
      fragment.querySelectorAll('[aria-describedby]').forEach(el=>{const ids=el.getAttribute('aria-describedby').split(/\s+/).filter(id=>id.startsWith('footnote-')).map(id=>'md-'+id);if(ids.length)el.setAttribute('aria-describedby',ids.join(' '));else el.removeAttribute('aria-describedby');});
      nameHeadings(fragment,source,headings,nonce);
      fragment.querySelectorAll('input').forEach(el=>{if(el.type!=='checkbox'){el.remove();return;}el.disabled=true;el.classList.add('task-list-item-checkbox');el.closest('li')?.classList.add('task-list-item');});
      fragment.querySelectorAll('a').forEach(link=>{if(link.namespaceURI!=='http://www.w3.org/1999/xhtml'){link.replaceWith(...link.childNodes);return;}const href=link.getAttribute('href')||'';if(href.startsWith('#')){let name=href.slice(1);try{name=decodeURIComponent(name);}catch{}link.setAttribute('href','#md-'+name);link.removeAttribute('target');}else if(/^(https?:\/\/|mailto:)/i.test(href)){link.setAttribute('target','_blank');link.setAttribute('rel','noopener noreferrer');}else{const resolved=context.resolveLink?.(href);if(typeof resolved==='string'&&resolved.startsWith('#/')){link.setAttribute('href',resolved);link.removeAttribute('target');}else{link.removeAttribute('href');link.title='Relative links need the original project files.';}}});
      fragment.querySelectorAll('img').forEach(img=>{const src=img.getAttribute('src')||'',local=context.resolveImage?.(src);if(typeof local==='string'&&local.startsWith('/api/')){img.setAttribute('src',local);img.loading='lazy';img.onerror=()=>{const label=document.createElement('span');label.className='markdown-image-placeholder';label.textContent=img.alt||'Image unavailable';img.replaceWith(label);};}else if(embedded(src)||remote(src)){img.referrerPolicy='no-referrer';img.loading='lazy';img.onerror=()=>{const label=document.createElement('span');label.className='markdown-image-placeholder';label.textContent=img.alt||'Image unavailable';img.replaceWith(label);};}else{const label=document.createElement('span');label.className='markdown-image-placeholder';label.textContent='Image: '+(img.alt||'attachment')+' (unavailable)';img.replaceWith(label);}});
      fragment.querySelectorAll('pre code').forEach(code=>{const lang=[...code.classList].find(c=>c.startsWith('language-'))?.slice(9);if(window.hljs&&lang&&hljs.getLanguage(lang)){try{UIHTML(code,hljs.highlight(code.textContent,{language:lang,ignoreIllegals:true}).value);code.classList.add('hljs');}catch{}}});
      // Each block takes its direction, and so its alignment, from its own
      // first letter, as descriptions and comments do. A list or table takes
      // one direction for all of its items, which sets the side its bullets
      // and columns start from. A direction the file sets stays.
      fragment.querySelectorAll('p,h1,h2,h3,h4,h5,h6,summary,ul,ol,dl,table').forEach(el=>{if(!el.hasAttribute('dir')&&!el.parentElement?.closest('ul,ol,dl,table'))el.setAttribute('dir','auto');});
      const article=document.createElement('article');article.className='markdown-body';article.append(fragment);ui.view.replaceChildren(article);ui.view.scrollTop=scroll;
      article.querySelectorAll('[data-md-math]').forEach(el=>{const expression=maths[Number(el.dataset.mdMath)];el.removeAttribute('data-md-math');if(!expression||!window.katex)return;el.className=expression.display?'markdown-math-block':'markdown-math-inline';if(expression.text.length>10000){el.textContent=expression.text;return;}try{katex.render(expression.text,el,{displayMode:expression.display,throwOnError:false,trust:false,maxExpand:1000,maxSize:20,strict:'ignore',output:'htmlAndMathml',macros:{}});}catch{el.textContent=expression.text;}});
      renderDiagrams(article,context);
    };
    ui.view.onclick=event=>{const link=event.target.closest('a');if(!link)return;const href=link.getAttribute('href');if(href?.startsWith('#md-')){event.preventDefault();const target=[...ui.view.querySelectorAll('[id]')].find(el=>el.id===href.slice(1));if(target){const scroller=ui.view.closest('.knowledge-reader')||ui.view;scroller.scrollTo({top:scroller.scrollTop+target.getBoundingClientRect().top-scroller.getBoundingClientRect().top-16,behavior:UIMotion.reduced()?'auto':'smooth'});target.tabIndex=-1;target.focus({preventScroll:true});}}};
    render();
  }
  function html(host,file,text){
    const ui=shell(host,'HTML',text.slice(0,200000),file.size>200000||text.length>200000);
    // Preserve existing selectors used by callers and checks.
    ui.tools.querySelector('[data-view-preview]').setAttribute('data-html-rendered','');ui.tools.querySelector('[data-view-source]').setAttribute('data-html-source','');
    const restart=document.createElement('button');restart.className='btn icon';restart.type='button';restart.title='Reload preview';restart.setAttribute('aria-label','Reload preview');UIHTML(restart,'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 0-2.3 5.7"/></svg>');restart.setAttribute('data-html-restart','');restart.hidden=!file.htmlPreviewUrl;ui.tools.append(restart);
    // Only the server's preview address shows the page, under its sandbox policy.
    const start=()=>{
      if(!file.htmlPreviewUrl){UIHTML(ui.view,'<p class="preview-unavailable">Preview unavailable. Download the original file.</p>');return;}
      const frame=document.createElement('iframe');frame.className='html-preview';frame.setAttribute('sandbox','');frame.setAttribute('referrerpolicy','no-referrer');frame.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'; payment 'none'");frame.title=file.name.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'')+' preview';frame.tabIndex=0;
      const url=new URL(file.htmlPreviewUrl,location.href);url.searchParams.set('reload',String(Date.now()));frame.src=url.href;ui.view.replaceChildren(frame);
    };
    ui.onMode(rendered=>{restart.hidden=!rendered||!file.htmlPreviewUrl;if(rendered){if(!ui.view.firstChild)start();}else ui.view.replaceChildren();});
    restart.onclick=start;start();
  }

  /** Plain text, with JSON indented when the whole file is present. */
  function text(host,file,value,truncated){
    host.replaceChildren();let shown=value;
    if(String(file.name).toLowerCase().endsWith('.json')&&!truncated){try{shown=JSON.stringify(JSON.parse(value),null,2);}catch{}}
    const pre=document.createElement('pre');pre.className='file-source-text';pre.tabIndex=0;pre.textContent=shown;host.append(pre);
    if(truncated){const note=document.createElement('p');note.className='access-note';note.textContent='Preview truncated to 200 KB. Download the full file.';host.prepend(note);}
  }
  window.FileViews={markdown,html,text};
})();
