const assert=require('assert/strict'),path=require('path'),Module=require('module');
const load=Module._load;
Module._load=function(name,...args){return name==='vscode'?{}:load.call(this,name,...args);};
const ext=require('../src/extension'),parameters=require('../src/workbench/parameter-service'),services=require('../src/workbench/services');
Module._load=load;
(async()=>{
 const base=path.resolve('/project/configs'),output=path.resolve('/runs/experiment');
 const config={checkpointIntervalEpochs:5,datasetDir:'../dataset',outputDir:output,resume:'./last.pt',trainingMode:'resume'};
 const normalized=ext.normalizeTrainingConfig(config,base);
 assert.equal(normalized.resume,path.join(output,'last.pt'));
 const args=ext.buildTrainingArgs({...normalized,epochs:1});assert.equal(args[args.indexOf('--checkpoint-interval-epochs')+1],'5');
 assert.equal(normalized.datasetDir,path.resolve(base,'../dataset'));
 assert.equal(ext.buildTrainingArgs({...normalized,epochs:1})[ext.buildTrainingArgs({...normalized,epochs:1}).indexOf('--resume')+1],path.join(output,'last.pt'));
 let handler;const calls=[],responses=[];
 const original=services.backend;
 services.backend=async(_context,_root,operation,payload)=>{calls.push({operation,payload});return {};};
 try{
  parameters.attach({webview:{onDidReceiveMessage:fn=>handler=fn,postMessage:m=>responses.push(m)}},{},()=>'/application',()=>base);
  await handler({type:'training/checkpoint',path:'./last.pt',outputDir:output});
  assert.equal(calls.at(-1).payload.path,path.join(output,'last.pt'));
  assert.equal(responses.at(-1).path,'./last.pt');
  await handler({type:'training/checkpoint',path:'./last.pt',outputDir:'/other-run'});
  assert.equal(calls.at(-1).payload.path,path.resolve('/other-run/last.pt'));
  await handler({type:'training/sources',config});
  assert.equal(calls.at(-1).payload.resume,path.join(output,'last.pt'));
  await handler({type:'training/checkpoint',path:'/external/best.pt',outputDir:output});
  assert.equal(calls.at(-1).payload.path,path.resolve('/external/best.pt'));
 }finally{services.backend=original;}
 console.log('Workbench resume paths use Output directory for inspection, source validation and CLI execution.');
})().catch(error=>{console.error(error);process.exitCode=1;});
