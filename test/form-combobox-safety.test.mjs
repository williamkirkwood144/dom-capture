import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { actions, observeForms, rejectVisibleFormValues } from '../tools/fidelity-observations.mjs';
import { validateConfig } from '../tools/evidence-runner.mjs';

const origin='https://api.leadconnectorhq.com';
const base={allowlist:['https://source.example.test'],captures:[{
  name:'form',url:'https://source.example.test/',selector:'body',
  state:{actions:[{action:'form_combobox_open',selector:'iframe[data-form]'}],afterCaptureActions:[{action:'form_combobox_dismiss',selector:'iframe[data-form]'}]},
}]};
assert.doesNotThrow(()=>validateConfig(base));
assert.throws(()=>validateConfig({...base,captures:[{...base.captures[0],state:{...base.captures[0].state,actions:[{action:'click',selector:'#other'},...base.captures[0].state.actions]}}]}),/sole state action/);
assert.throws(()=>validateConfig({...base,captures:[{...base.captures[0],state:{actions:base.captures[0].state.actions}}]}),/paired Escape/);
assert.throws(()=>validateConfig({...base,captures:[{...base.captures[0],state:{...base.captures[0].state,afterCaptureActions:[{action:'form_combobox_dismiss',selector:'#wrong'}]}}]}),/matching selector/);

const { createServer }=await import('node:http');
const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><title>Test</title><body>parent</body>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browserOptions={headless:true};if(process.env.CHROME_BIN)browserOptions.executablePath=process.env.CHROME_BIN;
const browser=await chromium.launch(browserOptions);
let childHtml;
const childBase=`<!doctype html><html><body>
<div id="combo" role="combobox" tabindex="0" aria-expanded="false" aria-controls="options">Choose an enquiry type</div>
<div id="options" role="listbox" hidden><div role="option">Full Service</div><div role="option">Negotiation</div></div><div role="status" aria-live="polite">PRIVATE_DYNAMIC_STATUS_SENTINEL</div>
<script>window.events=[];const c=document.querySelector('[role=combobox]'),l=document.querySelector('[role=listbox]');c.onclick=()=>{events.push('open');l.hidden=false;c.setAttribute('aria-expanded','true')};c.onkeydown=e=>{if(e.key==='Escape'){events.push('escape');l.hidden=true;c.setAttribute('aria-expanded','false')}};</script>
</body></html>`;
childHtml=childBase;
try{
  const page=await browser.newPage();
  await page.route(`${origin}/widget/form/fixture`,route=>route.fulfill({status:200,contentType:'text/html',body:childHtml}));
  const parentUrl=`http://127.0.0.1:${server.address().port}/`;
  await page.goto(parentUrl);
  await page.locator('body').evaluate((body,url)=>{const f=document.createElement('iframe');f.dataset.form='';f.src=url;f.style='width:500px;height:500px';body.append(f)},`${origin}/widget/form/fixture`);
  const specs=[{selector:'iframe[data-form]',allowedOrigins:[origin]}];
  await page.waitForTimeout(100);
  await assert.doesNotReject(()=>rejectVisibleFormValues(page,specs),'authored static combobox prompt is not treated as user-entered value');
  const formInventory=await observeForms(page,[{...specs[0],role_id:'fixture-form'}]);
  assert.ok(formInventory[0].statuses.every(status=>!('text'in status)));
  assert.ok(!JSON.stringify(formInventory).includes('PRIVATE_DYNAMIC_STATUS_SENTINEL'));
  const trace=await actions(page,[{action:'form_combobox_open',selector:'iframe[data-form]'}]);
  const observation=trace[0].mediaObservation;
  assert.equal(observation.open,true);
  assert.deepEqual(observation.roles.map(r=>r.role),['combobox','listbox','option','option']);
  assert.deepEqual(observation.roles.slice(2).map(r=>r.text),['Full Service','Negotiation']);
  assert.ok(observation.roles.slice(0,2).every(r=>!('text'in r)));
  assert.ok(observation.roles.every(r=>!('value'in r)&&!('inputValue'in r)));
  await actions(page,[{action:'form_combobox_dismiss',selector:'iframe[data-form]'}]);
  const frame=await page.locator('iframe[data-form]').elementHandle().then(el=>el.contentFrame());
  assert.deepEqual(await frame.evaluate(()=>window.events),['open','escape']);

  const variants=[
    '<input value="FORM_PRIVATE_SENTINEL" type="text">',
    '<input value="FORM_PRIVATE_SENTINEL" type="text" disabled>',
    '<input value="FORM_PRIVATE_SENTINEL" type="text" readonly>',
    '<textarea>FORM_PRIVATE_SENTINEL</textarea>',
    '<select><option value="">Choose</option><option value="FORM_PRIVATE_SENTINEL" selected>Selected</option></select>',
    '<div contenteditable="true">FORM_PRIVATE_SENTINEL</div>',
    '<div role="textbox" aria-valuetext="FORM_PRIVATE_SENTINEL">FORM_PRIVATE_SENTINEL</div>',
    '<div role="combobox" aria-autocomplete="list" aria-valuetext="FORM_PRIVATE_SENTINEL">FORM_PRIVATE_SENTINEL</div>',
  ];
  for(const control of variants){
    childHtml=childBase.replace('</body>',`${control}</body>`);
    await frame.goto(`${origin}/widget/form/fixture`);
    await page.waitForTimeout(50);
    await assert.rejects(()=>rejectVisibleFormValues(page,specs),/privacy rejected: visible child-frame form value present/);
    assert.ok(!page.url().includes('FORM_PRIVATE_SENTINEL'));
  }
  await assert.rejects(()=>actions(page,[{action:'form_combobox_open',selector:'iframe[data-form]'}]),/combobox/,'multiple comboboxes are rejected');
  childHtml=childBase.replace('</body>','<input name="autofill" value="FORM_PRIVATE_SENTINEL" type="text"></body>');
  await frame.goto(`${origin}/widget/form/fixture`);
  await frame.locator('[role="combobox"]').waitFor({state:'visible'});
  const opened=await actions(page,[{action:'form_combobox_open',selector:'iframe[data-form]'}]);
  assert.equal(opened[0].mediaObservation.open,true);
  let screenshotAttempts=0,privacyError;
  try{
    await rejectVisibleFormValues(page,specs);
    screenshotAttempts++;
    await page.screenshot();
  }catch(error){
    privacyError=error;
    const cleaned=await actions(page,[{action:'form_combobox_dismiss',selector:'iframe[data-form]'}]);
    assert.equal(cleaned[0].mediaObservation.dismissed,true,'Escape cleanup runs after privacy rejection');
  }
  assert.match(privacyError?.message||'',/privacy rejected: visible child-frame form value present/);
  assert.equal(screenshotAttempts,0,'privacy refusal occurs before screenshot');
  assert.ok(!JSON.stringify({message:privacyError?.message,opened}).includes('FORM_PRIVATE_SENTINEL'),'guard error and action trace never serialize the field value');
  assert.deepEqual(await frame.evaluate(()=>window.events),['open','escape']);

  const attackerPage=await browser.newPage();await attackerPage.route('https://attacker.invalid/frame',route=>route.fulfill({status:200,contentType:'text/html',body:childBase}));await attackerPage.goto(parentUrl);
  await attackerPage.locator('body').evaluate((body)=>{const f=document.createElement('iframe');f.dataset.form='';f.src='https://attacker.invalid/frame';body.append(f)});
  await attackerPage.waitForTimeout(50);
  await assert.rejects(()=>actions(attackerPage,[{action:'form_combobox_open',selector:'iframe[data-form]'}]),/origin unapproved/);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
console.log('form combobox fail-first safety tests passed');
