import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const here=path.dirname(fileURLToPath(import.meta.url));
const captureJs=await readFile(path.join(here,'../extension/src/capture.js'),'utf8');
const options={headless:true};if(process.env.CHROME_BIN)options.executablePath=process.env.CHROME_BIN;
const browser=await chromium.launch(options);
try{
  const page=await browser.newPage();
  await page.setContent(`<!doctype html><html><body><main id="root">
    <input type="text" value="TEXT_PRIVATE_SENTINEL">
    <input type="hidden" value="HIDDEN_PRIVATE_SENTINEL">
    <input type="password" value="PASSWORD_PRIVATE_SENTINEL">
    <textarea>TEXTAREA_PRIVATE_SENTINEL</textarea>
    <select><option value="OPTION_PRIVATE_SENTINEL" selected>Selected label</option></select>
    <input type="submit" value="Send enquiry"><button>Button label</button>
    <script>
      const nativeAttrValue=Object.getOwnPropertyDescriptor(Attr.prototype,'value');
      Object.defineProperty(Attr.prototype,'value',{configurable:true,get(){const owner=this.ownerElement;const safe=owner?.matches('input[type="button"],input[type="submit"],input[type="reset"]');if(this.name.toLowerCase()==='value'&&owner?.matches('input,textarea,select,option')&&!safe)throw Error('FORM_VALUE_ATTRIBUTE_READ');return nativeAttrValue.get.call(this);},set(value){return nativeAttrValue.set.call(this,value);}});
      window.liveReads=0;for(const el of document.querySelectorAll('input,textarea,select,option'))Object.defineProperty(el,'value',{configurable:true,get(){window.liveReads++;throw Error('LIVE_FORM_VALUE_READ');},set(){}});
    </script>
  </main></body></html>`);
  await page.addScriptTag({content:captureJs});
  const snapshot=await page.locator('#root').evaluate(async root=>(await window.__domCapture.capture(root)).page);
  assert.equal(await page.evaluate(()=>window.liveReads),0,'no live form values may be read');
  for(const secret of ['TEXT_PRIVATE_SENTINEL','HIDDEN_PRIVATE_SENTINEL','PASSWORD_PRIVATE_SENTINEL','TEXTAREA_PRIVATE_SENTINEL','OPTION_PRIVATE_SENTINEL'])assert.ok(!snapshot.includes(secret),`${secret} is omitted`);
  assert.ok(!/<option\b[^>]*\bselected(?:\s|=|>)/i.test(snapshot),'selected state is omitted');
  assert.match(snapshot,/<input[^>]*type="submit"[^>]*value="Send enquiry"/i,'authored submit label survives as static visible copy');
  assert.ok(snapshot.includes('Button label'));
}finally{await browser.close();}
console.log('form value serialization protections passed');
