// Tests for scripts/release-metadata.mjs: tag validation, release notes and image tags.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const script=join(root,'scripts/release-metadata.mjs');
function fixture(version,notes,run){
  mkdirSync(join(root,'target'),{recursive:true});
  const cwd=mkdtempSync(join(root,'target','release-metadata-'));
  try{
    writeFileSync(join(cwd,'Cargo.toml'),`[package]\nversion = "${version}"\n`);
    writeFileSync(join(cwd,'CHANGELOG.md'),notes);
    run(tag=>spawnSync(process.execPath,[script,tag],{cwd,encoding:'utf8',env:{...process.env,GITHUB_OUTPUT:join(cwd,'outputs')}}),cwd);
  }finally{rmSync(cwd,{recursive:true,force:true});}
}
test('release candidates cannot move stable Docker tags and notes exclude other versions',()=>{
  fixture('1.2.3-rc.1','# Changelog\n\n## [Unreleased]\nNext work\n\n## [1.2.3-rc.1] - 2026-09-27\n\nCandidate notes\n\n## [1.2.2]\nOld notes\n',(run,cwd)=>{
    const result=run('v1.2.3-rc.1');assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).tags,['ghcr.io/code19m/oneloop:1.2.3-rc.1']);
    assert.equal(readFileSync(join(cwd,'target/release-notes.md'),'utf8'),'Candidate notes\n');
  });
});
test('final releases include minor and latest image tags; bad tags/versions fail',()=>{
  fixture('1.2.3','## [1.2.3] - 2026-09-27\n\nStable notes\n',run=>{
    const result=run('v1.2.3');assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).tags,['ghcr.io/code19m/oneloop:1.2.3','ghcr.io/code19m/oneloop:1.2','ghcr.io/code19m/oneloop:latest']);
    for(const tag of ['v1.2.4','v1.2.3-beta.1','v1.2.3-rc.0'])assert.notEqual(run(tag).status,0,tag);
  });
});
test('release cannot reuse Unreleased prose in place of versioned notes',()=>{
  fixture('1.2.3','## [Unreleased]\nUnreviewed\n',run=>assert.notEqual(run('v1.2.3').status,0));
});
