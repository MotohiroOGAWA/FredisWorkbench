// Development checks locate the installed backend; no sibling checkout is required.
const path=require('path'),{execFileSync}=require('child_process');
const workbenchRoot=path.resolve(__dirname,'..');
let cached;
function backendRoot(){
 if(!cached)cached=process.env.FREDIS_APPLICATION_ROOT||execFileSync(process.env.FREDIS_PYTHON||'python',['-c','from pathlib import Path; import fredis; print(Path(next(iter(fredis.__path__))).resolve().parent)'],{encoding:'utf8'}).trim();
 return cached;
}
module.exports={workbenchRoot,get applicationRoot(){return backendRoot();}};
