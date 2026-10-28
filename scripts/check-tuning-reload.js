const assert=require('assert/strict'),Module=require('module'),load=Module._load;
Module._load=function(name,parent,main){return name==='vscode'?{}:load.call(this,name,parent,main);};
const {JSDOM,VirtualConsole}=require('jsdom'),ext=require('../src/extension'),fixture=require('./fixtures');
const candidates=[512,256,128,64],key='patternArchitecture.shared.hidden_dim';
const architecture={hidden_dim:512,num_layers:3,num_heads:8,ffn_mult:4,max_degree:4,max_spatial_dist:4,max_edge_dist:4};
const config={datasetDir:'/prepared',outputDir:'/search',trainingMode:'new',architectureMode:'detailed',epochs:3,batchSize:4,lr:.001,
 modelConfig:{...fixture.model,reaction_model_params:{...fixture.model.reaction_model_params,pattern_model_params:{0:{...architecture},1:{...architecture}}}},
 patternArchitecture:{mode:'shared',shared:{...architecture},frozenPatternIds:[]},tuning:{enabled:true,parameters:{[key]:candidates}}};
const patterns=[0,1].map(id=>({pattern:{name:'reaction '+id,pattern_id:id,reactant_smarts:'C'.repeat(id+1),products:[]},architecture:{...architecture},atom_count:id+1}));
const errors=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.detail?.stack||e.message));
const dom=new JSDOM(ext.workbenchHtml(fixture.dataConfig,config),{runScripts:'dangerously',virtualConsole:vc,beforeParse(w){w.acquireVsCodeApi=()=>({postMessage(){},getState:()=>({}),setState(){}});w.HTMLElement.prototype.scrollIntoView=function(){};w.ResizeObserver=class{observe(){}disconnect(){}};w.matchMedia=()=>({matches:false,addEventListener(){}});w.CSS={escape:s=>s};}});
const w=dom.window,d=w.document,form=d.getElementById('trainingForm');
const snapshot=()=>JSON.parse(JSON.stringify(w.eval('getTrainingConfig()')));
const post=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
const flush=async()=>{for(let i=0;i<5;i++)await Promise.resolve();};
(async()=>{
 try{
  // The shared architecture inputs do not exist until async dataset inspection.
  assert.equal(d.querySelector('[data-shared-pattern-parameter=hidden_dim]'),null);
  assert.deepEqual(snapshot().tuning.parameters[key],candidates,'Initialization must retain saved candidates before controls exist.');
  await flush();
  assert.deepEqual(snapshot().tuning.parameters[key],candidates);
  post({type:'training/sources',requestId:form.dataset.sourcesRequest,modelConfig:config.modelConfig,patternModels:patterns});await flush();
  const checkControls=()=>{
   const input=d.querySelector('[data-shared-pattern-parameter=hidden_dim]');assert(input);
   const [check,values]=input.parentElement.querySelector('.tuning-control').querySelectorAll('input');
   assert.equal(check.checked,true);assert.equal(values.hidden,false);assert.equal(values.value,'512, 256, 128, 64');
   assert.deepEqual(snapshot().tuning.parameters[key],candidates);
  };
  checkControls();
  // Reload a saved plan while dataset inspection is pending again.
  const args=ext.buildTrainingArgs(snapshot()),plan=JSON.parse(args[args.indexOf('--plan-json')+1]);
  post({type:'trainingConfig',config:ext.normalizeTrainingConfig(plan)});await flush();
  assert.deepEqual(snapshot().tuning.parameters[key],candidates);
  post({type:'training/sources',requestId:form.dataset.sourcesRequest,modelConfig:config.modelConfig,patternModels:patterns});await flush();checkControls();
  const reloadedArgs=ext.buildTrainingArgs(snapshot()),reloaded=JSON.parse(reloadedArgs[reloadedArgs.indexOf('--plan-json')+1]);
  assert.deepEqual(reloaded.trials.map(t=>t.config.patternArchitecture.shared.hidden_dim),candidates);
  // Explicitly changing mode must still drop candidates that no longer apply.
  const mode=d.getElementById('patternParameterMode');mode.value='individual';mode.dispatchEvent(new w.Event('change',{bubbles:true}));await flush();
  assert.equal(snapshot().tuning.parameters[key],undefined);
  assert.deepEqual(errors,[]);
  console.log('Shared tuning candidates survive delayed dataset inspection, save/reload and control recreation; explicit mode switching still clears incompatible candidates.');
 }finally{dom.window.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
