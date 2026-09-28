// @ts-check

export function showStartupError(error) {
  const root=document.getElementById('app');if(!root)return;
  const offline=error&&['network_error','aborted'].includes(error.code);
  root.replaceChildren();
  const wrap=document.createElement('main');wrap.className='auth-wrap';
  const card=document.createElement('section');card.className='auth-card';
  const heading=document.createElement('h1');heading.textContent=offline?'Cannot reach oneloop':'Could not start oneloop';
  const copy=document.createElement('p');copy.textContent=offline?'Check the server or your connection, then try again.':'The application could not load. Try again or check the server logs.';
  const retry=document.createElement('button');retry.className='btn primary';retry.type='button';retry.textContent='Try again';retry.addEventListener('click',()=>location.reload());
  card.append(heading,copy,retry);wrap.append(card);root.append(wrap);
}

import('./boot.js').catch(showStartupError);
