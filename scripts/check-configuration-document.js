const assert=require('assert/strict'),Module=require('module');
const listeners=[],requests=[],undo=[],redo=[];let receiver,disposed=false;
let text='{"epochs":1}\n',saved=text,saves=0;
const uri={toString:()=>'/run/config.pft'},document={uri,getText:()=>text,positionAt:offset=>offset,save:async()=>{saved=text;saves++;return true;}};
const vscode={WorkspaceEdit:class{replace(_uri,_range,value){this.text=value;}},Range:class{},commands:{executeCommand:async command=>requests.push(command)},workspace:{
 onDidChangeTextDocument:fn=>{listeners.push(fn);return {dispose(){disposed=true;}};},
 applyEdit:async edit=>{undo.push(text);text=edit.text;for(const fn of listeners)fn({document});return true;},
}};
const original=Module._load;Module._load=function(name,...args){return name==='vscode'?vscode:original.call(this,name,...args);};
const bridge=require('../src/workbench/configuration-document');Module._load=original;
const messages=[],restored=[];let dispose;
bridge.attach({webview:{onDidReceiveMessage:fn=>{receiver=fn;return {dispose(){}};},postMessage:m=>messages.push(m)},onDidDispose:fn=>dispose=fn},document,{kind:'training',serialize:value=>value,restore:value=>restored.push(value)});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 receiver({type:'configuration/edit',kind:'training',config:{epochs:2}});await flush();
 assert.notEqual(text,saved,'WorkspaceEdit must leave the document dirty');assert.equal(saves,0);assert.equal(restored.length,0);
 receiver({type:'configuration/save',kind:'training',config:{epochs:3}});await flush();
 assert.equal(JSON.parse(saved).epochs,3);assert.equal(text,saved);assert.equal(saves,1);
 redo.push(text);text=undo.pop();for(const fn of listeners)fn({document});
 assert.equal(restored.at(-1).epochs,2,'Undo updates the visible form');
 text=redo.pop();for(const fn of listeners)fn({document});assert.equal(restored.at(-1).epochs,3);
 receiver({type:'configuration/saveAs',kind:'training',config:{epochs:4}});await flush();
 assert.equal(requests.at(-1),'workbench.action.files.saveAs');assert.equal(JSON.parse(text).epochs,4);
 const before=text;receiver({type:'configuration/edit',kind:'data',config:{epochs:99}});await flush();assert.equal(text,before);
 assert.deepEqual(messages,[]);dispose();assert(disposed);
 console.log('Configuration document dirty state, queued Ctrl+S, Save As, undo/redo and cleanup passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
