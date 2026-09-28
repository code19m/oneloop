import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const css=readFileSync(new URL('../../styles/style.css',import.meta.url),'utf8');
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


test('light focus ring clears 3:1 on white, sidebar, controls and selected navigation',()=>{
  const ring=css.match(/--focus-ring:\s*(#[\da-f]{6})/i)[1];
  for(const surface of ['#ffffff','#f2f2f2','#f1f1f1','#e2e2e2'])assert(contrast(ring,surface)>=3,`${ring} on ${surface}`);
});
