// Synchronize Workbench forms with a VS Code text document for native dirty/save/undo.
const vscode=require('vscode');
function attach(panel,document,{kind,serialize,restore}){
 let applying=false,queue=Promise.resolve(),disposed=false;
 const report=error=>panel.webview.postMessage({type:kind==='training'?'trainingStatus':'status',status:'error',text:error.message});
 const subscription=vscode.workspace.onDidChangeTextDocument(event=>{
  if(!applying&&event.document.uri.toString()===document.uri.toString()){
   try{restore(JSON.parse(document.getText()));}catch(error){report(error);}
  }
 });
 const messages=panel.webview.onDidReceiveMessage(message=>{
  if(!['configuration/edit','configuration/save','configuration/saveAs'].includes(message.type))return;
  if(message.kind!==kind)return;
  queue=queue.then(async()=>{
   if(disposed)return;
   const text=JSON.stringify(serialize(message.config),null,2)+'\n';
   if(text!==document.getText()){
    const edit=new vscode.WorkspaceEdit();
    edit.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),text);
    applying=true;
    try{if(!await vscode.workspace.applyEdit(edit))throw new Error('Could not update configuration document.');}finally{applying=false;}
   }
   if(message.type==='configuration/saveAs')await vscode.commands.executeCommand('workbench.action.files.saveAs');
   if(message.type==='configuration/save'&&!await document.save())throw new Error('Could not save configuration document.');
  }).catch(report);
 });
 panel.onDidDispose(()=>{disposed=true;subscription.dispose();messages?.dispose();});
}
function script(kind){return `(()=>{
 const kind=${JSON.stringify(kind)},target=document.getElementById(kind==='training'?'trainingForm':'form');
 const snapshot=()=>kind==='training'?{...getTrainingConfig(),resume:target.elements.resume.value}:getConfig();
 let previous=JSON.stringify(snapshot()),scheduled=false;
 function publish(save=false,saveAs=false){const config=snapshot(),value=JSON.stringify(config);if(save||value!==previous){previous=value;vscode.postMessage({type:saveAs?'configuration/saveAs':save?'configuration/save':'configuration/edit',kind,config});}}
 function changed(){if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;publish();});}
 for(const type of ['input','change','click'])target.addEventListener(type,changed);
 document.getElementById(kind==='training'?'saveTraining':'save').onclick=()=>publish(true,true);
 document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'&&!event.shiftKey){event.preventDefault();event.stopPropagation();publish(true);}},true);
 window.addEventListener('message',event=>{const m=event.data;if(m.type===(kind==='training'?'trainingConfig':'config'))queueMicrotask(()=>{previous=JSON.stringify(snapshot());});else if(m.type==='picked'||m.type==='parameters/loaded'||m.type==='architecture/loaded')changed();});
})();`;}
module.exports={attach,script};
