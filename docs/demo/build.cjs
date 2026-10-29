const fs=require('fs'),path=require('path');
const ui=fs.readFileSync(path.join(__dirname,'ui.html'),'utf8');
const engine=fs.readFileSync(path.join(__dirname,'engine.js'),'utf8');
const result=ui.replace('/* ENGINE_SLOT */',()=>engine);
const out=path.join(__dirname,'index.html');
fs.writeFileSync(out,result);console.log(out);