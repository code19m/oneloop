import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';

const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const stylesheet=name=>read(`../../styles/${name}.css`);
const css=stylesheet('style');
// The app's own rules: every stylesheet the page links, and the overrides
// that markdown-preview.css appends to the vendored GitHub theme.
const linked=[...read('../../index.html').matchAll(/href="\/styles\/([\w-]+)\.css"/g)].map(match=>match[1]);
const appCss=[...linked.map(stylesheet),read('../../../scripts/markdown-preview-overrides.css')].join('\n');
const luminance=hex=>{
  const rgb=hex.match(/[\da-f]{2}/gi).map(part=>parseInt(part,16)/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4);
  return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
};
const contrast=(text,surface)=>{const a=luminance(text),b=luminance(surface);return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);};

test('muted labels meet normal-text contrast on both themes and selected controls',()=>{
  const [dark,light]=[...css.matchAll(/--ink-ghost:\s*(#[\da-f]{6})/gi)].map(match=>match[1]);
  for(const surface of ['#f1f1f1','#f2f2f2','#f4f4f4','#f7f7f7'])assert(contrast(light,surface)>=4.5,`${light} on ${surface}`);
  for(const surface of ['#2d2d2d','#373737'])assert(contrast(dark,surface)>=4.5,`${dark} on ${surface}`);
  const [darkCalendar,lightCalendar]=[...css.matchAll(/--text-tertiary:\s*(#[\da-f]{6})/gi)].map(match=>match[1]);
  assert(contrast(darkCalendar,'#373737')>=4.5);
  assert(contrast(lightCalendar,'#f1f1f1')>=4.5);
  assert.match(css,/\.cal-d\.out\s*\{\s*color:\s*var\(--ink-faint\)/);
});

test('every text on both comment bubbles and their quotes meets normal-text contrast on both themes',()=>{
  // Each theme's tokens, with var() resolved; light overrides the dark defaults.
  const block=selector=>Object.fromEntries([...css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(match=>[match[1],match[2].trim()]));
  const dark=block(':root'),themes={dark,light:{...dark,...block(':root\\[data-theme="light"\\]')}};
  const resolve=(tokens,value)=>value.replace(/var\((--[\w-]+)\)/g,(_,name)=>resolve(tokens,tokens[name]));
  const rgba=value=>{const hex=value.match(/^#([\da-f]{6})$/i);if(hex)return [...hex[1].match(/../g).map(part=>parseInt(part,16)),1];const [r,g,b,a=1]=value.match(/[\d.]+/g).map(Number);return [r,g,b,a];};
  const over=([r,g,b,a],surface)=>[r,g,b].map((value,index)=>value*a+surface[index]*(1-a));
  const hex=rgb=>'#'+rgb.map(value=>Math.round(value).toString(16).padStart(2,'0')).join('');
  // Everyone else's bubble and the person's own, as the app's styles mix them.
  const surfaces=[...appCss.matchAll(/--comment-surface:color-mix\(in srgb,var\((--[\w-]+)\) (\d+)%,var\((--[\w-]+)\)\)/g)];
  assert.equal(surfaces.length,2);
  for(const [name,tokens] of Object.entries(themes)){
    const color=token=>rgba(resolve(tokens,`var(${token})`)),check=(texts,surface)=>{for(const text of texts)assert(contrast(hex(color(text).slice(0,3)),hex(surface))>=4.5,`${name}: ${text} on ${hex(surface)}`);};
    for(const [,first,percent,second] of surfaces){
      const bubble=over([...color(first).slice(0,3),percent/100],color(second));
      // The body, author, Reply, Show more and removed note, time, and mentions.
      check(['--ink','--ink-soft','--ink-muted','--ink-ghost','--run'],bubble);
      // A quote's author and line, on its fill and hovered.
      for(const fill of ['--fill-hover','--fill-selected'])check(['--ink-soft','--ink-muted'],over(color(fill),bubble));
    }
  }
});

test('light focus ring clears 3:1 on white, sidebar, controls and selected navigation',()=>{
  const ring=css.match(/--focus-ring:\s*(#[\da-f]{6})/i)[1];
  for(const surface of ['#ffffff','#f2f2f2','#f1f1f1','#e2e2e2'])assert(contrast(ring,surface)>=3,`${ring} on ${surface}`);
});

test('stylesheets read only custom properties that something defines',()=>{
  // Templates and scripts set a few on elements, such as a Roadmap bar's --d.
  const scripts=['views','src'].flatMap(folder=>readdirSync(new URL(`../../${folder}`,import.meta.url),{recursive:true}).filter(file=>file.endsWith('.js')).map(file=>read(`../../${folder}/${file}`))).join('\n');
  const defined=new Set([...`${appCss}\n${scripts}`.matchAll(/(--[\w-]+)\s*:|setProperty\('(--[\w-]+)'/g)].map(match=>match[1]??match[2]));
  const missing=[...appCss.matchAll(/var\((--[\w-]+)\)/g)].map(match=>match[1]).filter(name=>!defined.has(name));
  assert.deepEqual([...new Set(missing)],[]);
});

test('no text is smaller than 12 px',()=>{
  const sizes=[...appCss.matchAll(/font(?:-size)?:[^;}]*?(\d+(?:\.\d+)?)px/g)].map(match=>Number(match[1]));
  assert.deepEqual(sizes.filter(size=>size<12),[]);
});

test('the Knowledge reader keeps its own width and padding inside the Markdown preview styles',()=>{
  const styles=['style','knowledge','markdown-preview'].map(name=>`<style>${stylesheet(name)}</style>`).join('');
  const markdown='<div class="markdown-scroll"><article class="markdown-body"></article></div>';
  const {window}=new JSDOM(`<html data-theme="light"><head>${styles}</head><body><div class="knowledge-preview-body">${markdown}</div><div class="file-preview-content">${markdown}</div></body></html>`);
  const [reader,preview]=[...window.document.querySelectorAll('.markdown-body')].map(element=>window.getComputedStyle(element));
  assert.deepEqual([reader.maxWidth,reader.paddingTop],['850px','34px']);
  assert.deepEqual([preview.maxWidth,preview.paddingTop],['980px','32px']);
  window.close();
});
