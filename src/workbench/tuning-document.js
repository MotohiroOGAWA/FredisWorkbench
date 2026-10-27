// Restore the editable form from new plans and legacy explicit Workbench trials.
function configuration(plan) {
 if(plan.configuration)return {...JSON.parse(JSON.stringify(plan.configuration)),outputDir:plan.outputDir,resume:'',trainingMode:'new'};
 const trials=plan.trials;
 if(!trials?.length||!trials[0].config?.modelConfig)throw new Error('This plan has no Workbench model configuration. Open the CLI grid as JSON.');
 const config=JSON.parse(JSON.stringify(trials[0].config)),parameters={};
 function collect(first,current,prefix=''){
  for(const [key,value]of Object.entries(current)){
   const name=prefix+key;
   if(value&&typeof value==='object'&&!Array.isArray(value)&&first[key]&&typeof first[key]==='object')collect(first[key],value,name+'.');
   else if(name!=='outputDir'&&JSON.stringify(value)!==JSON.stringify(first[key])){
    const values=parameters[name]??=[first[key]];
    if(!values.some(v=>JSON.stringify(v)===JSON.stringify(value)))values.push(value);
   }
  }
 }
 for(const trial of trials)collect(trials[0].config,trial.config);
 for(const key of Object.keys(parameters)){
  if(config.architectureMode==='shared'&&key.startsWith('modelConfig.')&&!/^modelConfig\.spectrum_model_params\.(ce_center|ce_scale)$/.test(key)||config.architectureMode==='shared'&&key.startsWith('patternArchitecture.')||config.patternArchitecture?.mode==='shared'&&key.startsWith('modelConfig.reaction_model_params.pattern_model_params.'))delete parameters[key];
 }
 config.outputDir=plan.outputDir;config.resume='';config.trainingMode='new';config.overwrite=false;
 config.tuning={enabled:true,parameters};
 return config;
}
module.exports={configuration};
