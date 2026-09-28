// Write audit-only npm manifests for the exact vendored versions so npm audit can check them; --check fails when stale.
// They are never an install or build input.
import {readFileSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const vendor=join(root,'frontend/vendor');
const inventory=JSON.parse(readFileSync(join(vendor,'mermaid/notice-inventory.json'),'utf8'));

for(const entry of readdirSync(vendor,{withFileTypes:true}).filter(entry=>entry.isDirectory())){
  const readme=readFileSync(join(vendor,entry.name,'README.md'),'utf8');
  const source=readme.match(/https:\/\/registry\.npmjs\.org\/([^\s`\])]+\.tgz)/)?.[0];
  const integrity=readme.match(/sha512-[A-Za-z0-9+/=]+/)?.[0];
  if(!source||!integrity)throw new Error(`Missing exact npm source/integrity: ${entry.name}`);
  const name=source.split('registry.npmjs.org/')[1].split('/-/')[0];
  const version=source.match(/-([0-9][^/]+)\.tgz$/)[1];
  const rows=new Map(entry.name==='mermaid'?inventory.map(row=>[row.package,row]):[]);
  rows.set(`${name}@${version}`,{package:`${name}@${version}`,source,integrity});
  const dependencies={},packages={};
  for(const [i,row] of [...rows.values()].sort((a,b)=>a.package<b.package?-1:a.package>b.package?1:0).entries()){
    const split=row.package.lastIndexOf('@'),name=row.package.slice(0,split),version=row.package.slice(split+1);
    // Aliases represent multiple bundled versions independently without resolving ranges.
    const alias=`bundled-${i}`;
    dependencies[alias]=`npm:${name}@${version}`;
    packages[`node_modules/${alias}`]={name,version,resolved:row.source,integrity:row.integrity};
  }
  const manifest={name:'oneloop-vendor-audit',version:'0.0.0',private:true,description:'Generated audit-only inventory; do not install or independently update',dependencies};
  const lock={name:manifest.name,version:manifest.version,lockfileVersion:3,requires:true,packages:{'':manifest,...packages}};
  const destination=join(vendor,entry.name);mkdirSync(destination,{recursive:true});
  for(const [name,value] of [['package.json',manifest],['package-lock.json',lock]]){
    const text=JSON.stringify(value,null,2)+'\n',path=join(destination,name);
    if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==text)throw new Error(`Stale ${path}`);}
    else writeFileSync(path,text);
  }
  console.log(`Vendor audit inventory: ${rows.size} exact package versions`);
}
