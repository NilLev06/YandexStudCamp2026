const fs = require('node:fs');
const path = require('node:path');
const source=fs.readFileSync(path.join(__dirname,'ui.html'),'utf8');
const engine=fs.readFileSync(path.join(__dirname,'engine.js'),'utf8');
const out=path.join(__dirname,'Демонстрация.html');
fs.writeFileSync(out,source.replace('/* ENGINE_SLOT */',()=>engine));
console.log(out);
