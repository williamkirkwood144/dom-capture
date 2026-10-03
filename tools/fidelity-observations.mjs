// Observation only. Selectors/roles belong to run inputs, never generic code.
export async function observe(page, roles, timeoutMs=10000){
  const observations=await page.evaluate(async ({roles,timeoutMs})=>{
    const targets=roles.map(r=>({...r,element:document.querySelector(r.selector)}));
    const unresolvedRoles=targets.filter(r=>!r.element).map(({section_id,role_id,selector})=>({section_id,role_id,selector,status:'missing_selector'}));
    const presentTargets=targets.filter(r=>r.element);
    const backgrounds=[];
    for(const root of presentTargets.map(r=>r.element))for(const el of [root,...root.querySelectorAll('*')]){
      if(!el.getClientRects().length)continue;
      for(const pseudo of [null,'::before','::after']){
        const css=getComputedStyle(el,pseudo),urls=[...css.backgroundImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map(m=>m[1]);
        for(const url of urls){let timer;const img=new Image();img.src=url;const status=await Promise.race([img.decode().then(()=>img.naturalWidth>0?'loaded':'failed',()=> 'failed'),new Promise(resolve=>timer=setTimeout(()=>resolve('timed-out'),timeoutMs))]);clearTimeout(timer);backgrounds.push({url,status,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,pseudo,backgroundPosition:css.backgroundPosition,backgroundSize:css.backgroundSize});}
      }
    }
    return {backgrounds,unresolvedRoles,roles:presentTargets.map(({element:el,...r})=>{const s=getComputedStyle(el),b=el.getBoundingClientRect();let effectiveOpacity=1;const opacityChain=[];for(let ancestor=el;ancestor;ancestor=ancestor.parentElement){const style=getComputedStyle(ancestor);effectiveOpacity*=Number(style.opacity);opacityChain.push({id:ancestor.id,tag:ancestor.tagName,opacity:style.opacity,visibility:style.visibility,display:style.display,transform:style.transform});}return {...r,bounds:{x:b.x+scrollX,y:b.y+scrollY,width:b.width,height:b.height},visible:!!el.getClientRects().length&&s.display!=='none'&&s.visibility!=='hidden'&&effectiveOpacity>0,effectiveOpacity,opacityChain,classes:el.className,attributes:{role:el.getAttribute('role'),ariaExpanded:el.getAttribute('aria-expanded'),ariaHidden:el.getAttribute('aria-hidden'),tabIndex:el.getAttribute('tabindex')},text:el.textContent,renderedText:typeof el.innerText==='string'?el.innerText:el.textContent,links:[...(el.matches('a')?[el]:[]),...el.querySelectorAll('a')].map(a=>({text:a.textContent,href:a.getAttribute('href')})),iframes:[...(el.matches('iframe')?[el]:[]),...el.querySelectorAll('iframe')].map(f=>({src:f.src,title:f.title})),href:el.getAttribute('href'),styles:Object.fromEntries(['fontFamily','fontSize','fontWeight','fontStyle','fontFeatureSettings','fontVariationSettings','fontSynthesis','textTransform','textDecorationLine','lineHeight','letterSpacing','color','backgroundColor','display','position','opacity','transform','objectFit','objectPosition'].map(k=>[k,s[k]])),images:[...(el.matches('img')?[el]:[]),...el.querySelectorAll('img')].map(i=>({currentSrc:i.currentSrc,naturalWidth:i.naturalWidth,naturalHeight:i.naturalHeight,complete:i.complete})),videos:[...(el.matches('video')?[el]:[]),...el.querySelectorAll('video')].map(v=>({src:v.currentSrc,poster:v.poster,readyState:v.readyState,paused:v.paused,currentTime:v.currentTime,muted:v.muted,loop:v.loop,autoplay:v.autoplay})),media:[...(el.matches('img')?[el]:[]),...el.querySelectorAll('img')].map(i=>({url:i.currentSrc,alt:i.getAttribute('alt')})),children:[...el.querySelectorAll('a,img,p,li,h1,h2,h3,h4,h5,h6,blockquote,th,td,figcaption,strong,em')].map(child=>child.matches('a')?{kind:'link',index:[...(el.matches('a')?[el]:[]),...el.querySelectorAll('a')].indexOf(child)}:child.matches('img')?{kind:'media',index:[...(el.matches('img')?[el]:[]),...el.querySelectorAll('img')].indexOf(child)}:{kind:'text_block',tag:child.tagName.toLowerCase(),text:child.textContent}),fonts:[]};})};
  },{roles,timeoutMs});
  const session=await page.context().newCDPSession(page);
  try{await session.send('DOM.enable');await session.send('CSS.enable');const {root}=await session.send('DOM.getDocument',{depth:-1,pierce:true});
    for(const r of observations.roles){const {nodeId}=await session.send('DOM.querySelector',{nodeId:root.nodeId,selector:r.selector});const {node}=await session.send('DOM.describeNode',{nodeId,depth:-1});const ids=[];const walk=n=>{if(n.nodeType===1||n.nodeType===3)ids.push(n.nodeId);for(const c of n.children||[])walk(c);};walk(node);const fonts=new Map();for(const id of ids){try{const result=await session.send('CSS.getPlatformFontsForNode',{nodeId:id});for(const f of result.fonts)fonts.set(JSON.stringify([f.familyName,f.postScriptName,f.isCustomFont]),f);}catch{}}
      r.fonts=[...fonts.values()];
    }
  }finally{await session.detach();}
  return observations;
}
export async function actions(page, steps=[]){
  const trace=[];
  for(const step of steps){const began=performance.now();
    let mediaObservation=null;
    if(step.action==='form_combobox_open'){const {frame,combo,origin}=await leadConnectorFormFrame(page,step);if(await combo.getAttribute('aria-expanded')==='true')throw Error('LeadConnector combobox already open');await combo.click();mediaObservation=await snapshotLeadConnectorCombobox(frame,origin);}
    else if(step.action==='form_combobox_dismiss'){const {frame,combo}=await leadConnectorFormFrame(page,step);if(await combo.getAttribute('aria-expanded')!=='true')throw Error('LeadConnector combobox is not open before Escape');await combo.press('Escape');await frame.waitForFunction(()=>{const combo=document.querySelector('[role="combobox"]'),shown=el=>{const s=getComputedStyle(el);return !!el.getClientRects().length&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0;};return combo?.getAttribute('aria-expanded')==='false'&&!([...document.querySelectorAll('[role="listbox"],[role="option"]')].some(shown));},null,{timeout:3000});mediaObservation={dismissed:true,key:'Escape',frame_origin:LEADCONNECTOR_FORM_ORIGIN};}
    else if(step.action==='diagnostic_font_size'){if(!Number.isInteger(step.pixels)||step.pixels<24||step.pixels>192)throw Error('invalid diagnostic heading size');const target=page.locator(step.selector);if(await target.count()!==1)throw Error('diagnostic heading must be unique');mediaObservation=await target.evaluate((el,pixels)=>{if(!['H1','H2'].includes(el.tagName))throw Error('diagnostic target must be heading');const before={fontSize:getComputedStyle(el).fontSize,bounds:el.getBoundingClientRect().toJSON()};el.style.fontSize=pixels+'px';return {before,after:{fontSize:getComputedStyle(el).fontSize,bounds:el.getBoundingClientRect().toJSON()},diagnostic:true};},step.pixels);}
    else if(step.action==='video_seek')mediaObservation=await freezeVideoPhase(page,step);
    else if(step.action==='video_play')mediaObservation=await playVideo(page,step);
    else if(step.action==='scroll'){if(!Number.isFinite(step.x??0)||!Number.isFinite(step.y)||Math.abs(step.y)>100000)throw Error('invalid bounded scroll');await page.evaluate(({x,y})=>scrollTo({left:x,top:y,behavior:'instant'}),{x:step.x||0,y:step.y});}
    else if(step.action==='key'){if(!['Tab','Shift+Tab','Enter','Space','Escape','ArrowDown','ArrowUp'].includes(step.key))throw Error('unsupported key');await page.keyboard.press(step.key);}
    else {const locator=page.locator(step.selector).first();if(step.action==='click')await locator.click();else if(step.action==='touch')await locator.tap();else if(step.action==='hover')await locator.hover();else if(step.action==='focus')await locator.focus();else throw Error('unsupported action');}
    if(step.waitMs)await page.waitForTimeout(Math.min(step.waitMs,10000));trace.push({...step,mediaObservation,elapsed_ms:performance.now()-began,actual:await page.evaluate(()=>({scrollX,scrollY,focus:document.activeElement?.getAttribute('id')}))});
  }return trace;
}
// Named public player API only. No source-script/config JavaScript execution.
export async function freezeVideoPhase(page, spec){
  if(!spec||!['html5','vimeo'].includes(spec.provider)||typeof spec.selector!=='string'||!Number.isFinite(spec.seconds)||spec.seconds<0||spec.seconds>3600)throw Error('invalid video phase request');
  const target=page.locator(spec.selector);if(await target.count()!==1)throw Error('video phase target must be unique');
  if(spec.provider==='html5')return target.evaluate(async (video,seconds)=>{
    if(!(video instanceof HTMLVideoElement))throw Error('phase target is not video');video.pause();
    const seeked=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('video seek timeout')),10000);if(video.currentTime===seconds){clearTimeout(timer);resolve();}else video.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true});});video.currentTime=seconds;await seeked;
    if(!video.paused||video.readyState<2||!video.videoWidth||Math.abs(video.currentTime-seconds)>0.05)throw Error('video phase not observed decoded/paused');return {provider:'html5',requested_seconds:seconds,currentTime:video.currentTime,paused:video.paused,readyState:video.readyState,videoWidth:video.videoWidth,videoHeight:video.videoHeight};
  },spec.seconds);
  const response=await target.evaluate(async (iframe,spec)=>{
    const url=new URL(iframe.src);if(url.origin!=='https://player.vimeo.com'||!/^\/video\/\d+$/.test(url.pathname))throw Error('not a public Vimeo player origin');
    if(spec.video_id&&url.pathname!=='/video/'+spec.video_id)throw Error('Vimeo video identity differs');
    const calls=[];
    const call=(method,value)=>new Promise((resolve,reject)=>{
      const onMessage=event=>{if(event.origin!==url.origin||event.source!==iframe.contentWindow)return;let data=event.data;try{if(typeof data==='string')data=JSON.parse(data);}catch{return;}
        if(data.method===method){cleanup();calls.push({method,value:data.value});resolve(data.value);}else if(data.event==='error'&&data.data?.method===method){cleanup();reject(Error(data.data.message));}};
      const cleanup=()=>{clearTimeout(timer);removeEventListener('message',onMessage);};const timer=setTimeout(()=>{cleanup();reject(Error('Vimeo API timeout '+method));},10000);addEventListener('message',onMessage);iframe.contentWindow.postMessage({method,...(value===undefined?{}:{value})},url.origin);
    });
    await call('pause');await call('setCurrentTime',spec.seconds);const paused=await call('getPaused'),currentTime=await call('getCurrentTime'),video_id=await call('getVideoId');
    if(paused!==true||Math.abs(currentTime-spec.seconds)>0.05)throw Error('Vimeo did not observe requested paused phase');return {provider:'vimeo',origin:url.origin,video_id,requested_seconds:spec.seconds,currentTime,paused,calls};
  },spec);
  const frame=await target.contentFrame();
  // Playwright reads the actual frame in its own origin; no authentication/cookies moved.
  const decoded=await frame.locator('video').first().evaluate(v=>({readyState:v.readyState,videoWidth:v.videoWidth,videoHeight:v.videoHeight,currentTime:v.currentTime,paused:v.paused,quality:v.getVideoPlaybackQuality?.()}));
  if(decoded.readyState<2||decoded.videoWidth<1||!decoded.paused)throw Error('Vimeo frame not decoded/paused');return {...response,decoded};
}

export async function playVideo(page,spec){
 if(!['html5','vimeo'].includes(spec.provider)||typeof spec.selector!=='string')throw Error('invalid named video play');
 const target=page.locator(spec.selector);if(await target.count()!==1)throw Error('video target must be unique');
 if(spec.provider==='html5')return target.evaluate(async v=>{if(!(v instanceof HTMLVideoElement))throw Error('not video');await v.play();return {paused:v.paused,currentTime:v.currentTime,muted:v.muted,loop:v.loop,readyState:v.readyState};});
 return target.evaluate(async (iframe,spec)=>{
  const u=new URL(iframe.src);if(u.origin!=='https://player.vimeo.com'||!/^\/video\/\d+$/.test(u.pathname)||spec.video_id&&u.pathname!=='/video/'+spec.video_id)throw Error('Vimeo identity mismatch');
  const call=method=>new Promise((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);removeEventListener('message',receive);};const receive=e=>{if(e.origin!==u.origin||e.source!==iframe.contentWindow)return;let d=e.data;try{if(typeof d==='string')d=JSON.parse(d);}catch{return;}if(d.method===method){cleanup();resolve(d.value);}else if(d.event==='error'&&d.data?.method===method){cleanup();reject(Error(d.data.message));}};const timer=setTimeout(()=>{cleanup();reject(Error('Vimeo play timeout'));},10000);addEventListener('message',receive);iframe.contentWindow.postMessage({method},u.origin);});
  await call('play');const paused=await call('getPaused');if(paused)throw Error('Vimeo playback did not start');return {paused,currentTime:await call('getCurrentTime'),muted:await call('getMuted'),loop:await call('getLoop')};
 },spec);
}

// Read-only child-frame form inventory. No value reads, fills, validation dispatch or submit.
export async function observeForms(page,specs=[]){
 const forms=[];
 for(const spec of specs){
  if(typeof spec.selector!=='string'||!Array.isArray(spec.allowedOrigins)||!spec.allowedOrigins.length)throw Error('form observation needs exact frame origins');
  const target=page.locator(spec.selector);if(await target.count()!==1)throw Error('form frame selector must be unique');
  const element=await target.elementHandle();if(!element)throw Error("form frame element missing");
  const frame=await element.contentFrame();if(!frame)throw Error('form child frame missing');
  const url=new URL(frame.url());if(!spec.allowedOrigins.includes(url.origin))throw Error('form frame origin unapproved');
  if(spec.waitForSelector){if(typeof spec.waitForSelector!=='string')throw Error('form readiness selector invalid');await frame.waitForSelector(spec.waitForSelector,{state:'visible',timeout:30000});}
  const observed=await frame.evaluate(()=>{
   const shown=el=>{const s=getComputedStyle(el);return !!el.getClientRects().length&&s.display!=='none'&&s.visibility!=='hidden';};
   const box=el=>{const b=el.getBoundingClientRect();return {x:b.x+scrollX,y:b.y+scrollY,width:b.width,height:b.height};};
   const controls=[...document.querySelectorAll('input,select,textarea,button')].filter(shown).map(el=>({tag:el.tagName,type:el.type||null,id:el.id,name:el.name,labels:[...(el.labels||[])].map(l=>l.textContent),ariaLabel:el.getAttribute('aria-label'),placeholder:el.getAttribute('placeholder'),required:el.required||false,disabled:el.disabled||false,readOnly:el.readOnly||false,pattern:el.getAttribute('pattern'),min:el.getAttribute('min'),max:el.getAttribute('max'),minLength:el.minLength??null,maxLength:el.maxLength??null,bounds:box(el),styles:Object.fromEntries(['fontFamily','fontSize','color','backgroundColor','borderColor','opacity','transform'].map(k=>[k,getComputedStyle(el)[k]])),validity:el.validity?Object.fromEntries(['valid','valueMissing','typeMismatch','patternMismatch','tooLong','tooShort','rangeUnderflow','rangeOverflow','stepMismatch','badInput','customError'].map(k=>[k,el.validity[k]])):null}));
   const statuses=[...document.querySelectorAll('[role="alert"],[role="status"],[aria-live]')].filter(shown).map(el=>({role:el.getAttribute('role'),ariaLive:el.getAttribute('aria-live'),bounds:box(el)}));
   return {controls,statuses,scroll:{x:scrollX,y:scrollY},submission:'never_attempted',validation:'read_only_validity_no_events',success:'unobserved',error:'unobserved'};
  });
  forms.push({role_id:spec.role_id,selector:spec.selector,frame_origin:url.origin,frame_path:url.pathname,...observed});
 }
 return forms;
}

const LEADCONNECTOR_FORM_ORIGIN='https://api.leadconnectorhq.com';
const VISIBLE_FORM_ROLES='[role="combobox"], [role="listbox"], [role="option"]';
async function leadConnectorFormFrame(page,step){
 if(Object.keys(step).some(key=>!['action','selector'].includes(key)))throw Error('unexpected form combobox action field');
 if(typeof step.selector!=='string'||!step.selector.trim())throw Error('form combobox action requires a frame selector');
 const frameElement=page.locator(step.selector);if(await frameElement.count()!==1)throw Error('form frame selector must be unique');
 const handle=await frameElement.elementHandle();if(!handle)throw Error('form frame element missing');
 const frame=await handle.contentFrame();await handle.dispose();if(!frame)throw Error('form child frame missing');
 let origin;try{origin=new URL(frame.url()).origin;}catch{throw Error('form frame origin unapproved');}if(origin!==LEADCONNECTOR_FORM_ORIGIN)throw Error('form frame origin unapproved');
 const combo=frame.locator('[role="combobox"]');if(await combo.count()!==1)throw Error('form combobox must be unique');
 if(!await combo.isVisible())throw Error('form combobox is not visible');return {frame,combo,origin};
}
async function snapshotLeadConnectorCombobox(frame,origin){
 const snapshot=await frame.evaluate(selector=>{
  const visible=el=>{const s=getComputedStyle(el);return !!el.getClientRects().length&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0;};
  const roles=[...document.querySelectorAll(selector)].filter(visible).map(el=>{const role=el.getAttribute('role'),r=el.getBoundingClientRect();return {role,...(role==='option'?{text:(el.innerText||el.textContent||'').trim()}:{}),bounds:{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height},...(role==='combobox'?{aria:{expanded:el.getAttribute('aria-expanded'),controls:el.getAttribute('aria-controls'),haspopup:el.getAttribute('aria-haspopup')}}:{})};});
  const combo=document.querySelector('[role="combobox"]');return {open:combo?.getAttribute('aria-expanded')==='true'&&roles.some(r=>r.role==='listbox')&&roles.some(r=>r.role==='option'),roles};
 },VISIBLE_FORM_ROLES);
 if(!snapshot.open)throw Error('LeadConnector combobox did not expose a visible open listbox/options');
 return {frame_origin:origin,...snapshot};
}

// The check stays inside the allowlisted frame and returns only a boolean.
export async function rejectVisibleFormValues(page,specs=[]){
 for(const spec of specs){
  if(typeof spec.selector!=='string'||!Array.isArray(spec.allowedOrigins)||!spec.allowedOrigins.length)throw Error('privacy rejected: form frame needs exact allowed origins');
  const locator=page.locator(spec.selector);if(await locator.count()!==1)throw Error('privacy rejected: form frame selector is not unique');
  const handle=await locator.elementHandle(),frame=await handle?.contentFrame();if(!frame)throw Error('privacy rejected: form frame unavailable');
  if(!spec.allowedOrigins.includes(new URL(frame.url()).origin))throw Error('privacy rejected: form frame origin not allowed');
  const found=await frame.evaluate(()=>{
   const visible=el=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0;},nonempty=value=>String(value??'').trim().length>0;
   for(const el of document.querySelectorAll('input,textarea,select')){if(!visible(el))continue;if(el instanceof HTMLInputElement&&['button','submit','reset','image','hidden'].includes(el.type))continue;if(el instanceof HTMLInputElement&&['checkbox','radio'].includes(el.type)){if(el.checked)return true;continue;}if(nonempty(el.value))return true;}
   for(const el of document.querySelectorAll('[contenteditable=""],[contenteditable="true"],[role="textbox"],[role="combobox"]')){if(!visible(el))continue;const role=el.getAttribute('role'),editable=el.isContentEditable||role==='textbox'||(role==='combobox'&&['list','inline','both'].includes(el.getAttribute('aria-autocomplete')));if(!editable)continue;const placeholder=el.getAttribute('aria-placeholder')||el.getAttribute('placeholder')||'',rendered=el.getAttribute('aria-valuetext')||el.getAttribute('aria-valuenow')||el.innerText||el.textContent||'';if(nonempty(rendered)&&String(rendered).trim()!==String(placeholder).trim())return true;}
   return false;
  });
  if(found)throw Error('privacy rejected: visible child-frame form value present; screenshot and evidence omitted');
 }
 return {inspection:'transient_boolean_only',values_persisted:false};
}
