// Persist references relative to their owning configuration file.
const path=require('path');
const keys=new Set(['path','source','file','input','trainInput','validationInput','validation_input','resume','initialize_from','initializeFrom','params','modelPath','paramsPath','sourcePath']);
function relativePaths(value,base){
 if(Array.isArray(value))return value.map(item=>relativePaths(item,base));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,typeof item==='string'&&item&&(keys.has(key)||/(_dir|_path|Dir|Path)$/.test(key))&&path.isAbsolute(item)?path.relative(base,item)||'.':relativePaths(item,base)]));
 return value;
}
module.exports=relativePaths;
