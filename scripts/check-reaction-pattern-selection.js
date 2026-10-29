const assert=require('assert/strict'),Module=require('module');
const {JSDOM}=require('jsdom');
const load=Module._load;Module._load=function(name,...args){return name==='vscode'?{}:load.call(this,name,...args);};
const {workbenchHtml}=require('../src/extension');
const messages=[];
const dom=new JSDOM(workbenchHtml(require('./fixtures').dataConfig,{modelConfig:require('./fixtures').model}),{runScripts:'dangerously',pretendToBeVisual:true,beforeParse(w){w.acquireVsCodeApi=()=>({postMessage:m=>messages.push(m),getState:()=>({}),setState(){}});w.HTMLElement.prototype.scrollIntoView=function(){};w.ResizeObserver=class{observe(){}disconnect(){}};w.matchMedia=()=>({matches:false,addEventListener(){}});w.CSS={escape:s=>s};}});
(async()=>{const w=dom.window,d=w.document;try{
 d.getElementById('addVisualPattern').click();
 const apply=d.getElementById('applyReactant'),step=d.querySelector('.ce-step');
 await apply.onclick();assert.match(step.querySelector('.ce-error').textContent,/Draw a structure/);assert(!apply.disabled);assert(!apply.hasAttribute('aria-busy'));
 w.eval(`molGraph={atoms:[{index:0,x:0,y:0,symbol:'C'},{index:1,x:2,y:0,symbol:'O'}],bonds:[{index:0,begin:0,end:1,order:1}]};renderMolecule()`);
 const before=messages.length;await apply.onclick();assert.equal(messages.length,before);assert.match(step.querySelector('.ce-error').textContent,/Select at least one atom/);assert(!apply.disabled);assert(!apply.hasAttribute('aria-busy'));
 w.eval(`chemistry=async()=>({smarts:'[#6:1]',atomMapBySource:{0:1}})`);
 step.querySelector('[data-zoom="0.8"]').click();
 const canvas=d.getElementById('moleculeCanvas'),view=canvas.querySelector('svg').getAttribute('viewBox');
 w.eval('selectedAtoms.add(0);renderMolecule()');
 await new Promise(resolve=>setTimeout(resolve,250));
 assert.equal(canvas.querySelector('svg').getAttribute('viewBox'),view);
 // Product-only updates retain a manually chosen view as selection changes.
 w.eval(`productGraph=molGraph;productSelectedAtoms=new Set([0,1]);productSelectedBonds=new Set([0]);renderProduct()`);
 const productStep=d.getElementById('productCanvas').closest('.ce-step'),only=productStep.querySelector('[data-product-view="product"]');
 await only.parentElement.onclick({target:only});productStep.querySelector('[data-zoom="0.8"]').click();
 const pc=d.getElementById('productCanvas'),productView=pc.querySelector('svg').getAttribute('viewBox');
 // Trigger the async refresh used by selection edits with mapped display coordinates.
 w.eval(`completed=true;productAtomMaps={0:1,1:2};chemistry=async(command)=>command==='molecule'?{atoms:[{index:0,mapNumber:1,x:0,y:0,symbol:'C'}],bonds:[]}:{smarts:'[#6:1]'};productSelectedAtoms.delete(1);renderProduct()`);
 await new Promise(resolve=>setTimeout(resolve,250));assert.equal(pc.querySelector('svg').getAttribute('viewBox'),productView);
 console.log('Empty Apply validation and delayed reactant/product zoom preservation passed.');
}finally{w.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
