const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),Module=require('module');
const load=Module._load;Module._load=function(name,parent,main){return name==='vscode'?{}:load.call(this,name,parent,main);};
const {trainingCommandArgs,buildTrainingArgs}=require('../src/extension');
const fixtures=require('./fixtures');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'fredis-tuning-command-'));
(async()=>{
 try{
  const config={trainingMode:'new',architectureMode:'shared',datasetDir:'/data/prepared',outputDir:path.join(temporary,'search with spaces'),epochs:3,batchSize:4,lr:0.001,modelConfig:fixtures.model,sharedArchitecture:{hidden_dim:512,num_heads:4,num_layers:2},tuning:{enabled:true,parameters:{'sharedArchitecture.hidden_dim':[512,256,128,64]}}};
  const expanded=buildTrainingArgs(config),original=JSON.parse(expanded[expanded.indexOf('--plan-json')+1]);
  const args=await trainingCommandArgs(config);
  assert.deepEqual(args.slice(0,5),['-m','fredis.cli','train','tune-fragment-tree','--plan']);
  assert.equal(args.length,6);assert(!args.includes('--plan-json'));
  const file=args[5],saved=JSON.parse(fs.readFileSync(file));
  assert.deepEqual(saved.configuration.tuning.parameters['sharedArchitecture.hidden_dim'],[512,256,128,64]);
  assert.deepEqual(saved.trials,original.trials);
  assert.deepEqual(saved.trials.map(t=>t.config.sharedArchitecture.hidden_dim),[512,256,128,64]);
  assert.equal(saved.schema,'fredis.tuning-plan');
  assert(JSON.stringify(args).length<JSON.stringify(expanded).length/10);
  const stamp=fs.statSync(file).mtimeMs;
  assert.deepEqual(await trainingCommandArgs(config),args);
  assert.equal(fs.statSync(file).mtimeMs,stamp,'An identical copy must leave the saved plan untouched.');
  fs.writeFileSync(path.join(config.outputDir,'result.tuning.pft'),'{"status":"interrupted"}');
  assert.deepEqual(await trainingCommandArgs(config),args);
  const changed={...config,tuning:{enabled:true,parameters:{'sharedArchitecture.hidden_dim':[64,128]}}};
  await assert.rejects(trainingCommandArgs(changed),/differ from the executed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).trials,saved.trials);
  assert.deepEqual(await trainingCommandArgs({...config,tuning:{enabled:false}}),buildTrainingArgs({...config,tuning:{enabled:false}}));
  const source=path.join(temporary,'edited.tuning-plan.pft');
  fs.writeFileSync(source,'original plan must remain unchanged');
  const fresh={...config,outputDir:path.join(temporary,'new search')};
  const exported=await trainingCommandArgs(fresh,source);
  assert.equal(exported[5],path.join(fresh.outputDir,'fragment-tree.tuning-plan.pft'));
  assert.equal(fs.readFileSync(source,'utf8'),'original plan must remain unchanged');
  const exportedPlan=JSON.parse(fs.readFileSync(exported[5]));
  assert.equal(exportedPlan.outputDir,fresh.outputDir);
  assert(exportedPlan.trials.every(t=>path.dirname(t.config.outputDir)===fresh.outputDir));
  console.log('Short tuning commands preserve candidates, trial order, full settings, spaces and resume identity; changed executed plans are protected.');
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
