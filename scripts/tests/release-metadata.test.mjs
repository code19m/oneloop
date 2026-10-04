// Tests for scripts/release-metadata.mjs: tag validation, release notes and prerelease status.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root=fileURLToPath(new URL('../../',import.meta.url));
const script=join(root,'scripts/release-metadata.mjs');
function fixture(version,notes,run){
  const cwd=mkdtempSync(join(tmpdir(),'release-metadata-'));
  try{
    writeFileSync(join(cwd,'Cargo.toml'),`[package]\nversion = "${version}"\n`);
    writeFileSync(join(cwd,'CHANGELOG.md'),notes);
    run(tag=>spawnSync(process.execPath,[script,tag],{cwd,encoding:'utf8',env:{...process.env,GITHUB_OUTPUT:join(cwd,'outputs')}}),cwd);
  }finally{rmSync(cwd,{recursive:true,force:true});}
}
test('release candidates are identified and notes exclude other versions',()=>{
  fixture('1.2.3-rc.1','# Changelog\n\n## [Unreleased]\nNext work\n\n## [1.2.3-rc.1] - 2026-09-27\n\nCandidate notes\n\n## [1.2.2]\nOld notes\n',(run,cwd)=>{
    const result=run('v1.2.3-rc.1');assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),{version:'1.2.3-rc.1',prerelease:true});
    assert.equal(readFileSync(join(cwd,'outputs'),'utf8'),'version=1.2.3-rc.1\nprerelease=true\n');
    assert.equal(readFileSync(join(cwd,'target/release-notes.md'),'utf8'),'Candidate notes\n');
  });
});
test('final releases are identified; bad tags/versions fail',()=>{
  fixture('1.2.3','## [1.2.3] - 2026-09-27\n\nStable notes\n',run=>{
    const result=run('v1.2.3');assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),{version:'1.2.3',prerelease:false});
    for(const tag of ['v1.2.4','v1.2.3-beta.1','v1.2.3-rc.0'])assert.notEqual(run(tag).status,0,tag);
  });
});
test('release cannot reuse Unreleased prose in place of versioned notes',()=>{
  fixture('1.2.3','## [Unreleased]\nUnreviewed\n',run=>assert.notEqual(run('v1.2.3').status,0));
});
test('release notes need visible content, not just reference definitions or comments',()=>{
  for(const notes of ['', '[release]: https://example.com/release', '[release]:\n  https://example.com/release\n  "Release comparison"', '<!-- Notes still need to be written. -->\n\n[release]: https://example.com/release']){
    fixture('1.2.3',`## [1.2.3] - 2026-10-04\n\n${notes}\n`,run=>{
      const result=run('v1.2.3');
      assert.notEqual(result.status,0,notes);
      assert.match(result.stderr,/Release notes are empty/);
    });
  }
});
test('visible release notes keep reference definitions in the published Markdown',()=>{
  const notes='See the [fixed bug][issue].\n\n[issue]: https://example.com/issues/123 "Bug report"';
  fixture('1.2.3',`## [1.2.3] - 2026-10-04\n\n${notes}\n`,(run,cwd)=>{
    const result=run('v1.2.3');assert.equal(result.status,0,result.stderr);
    assert.equal(readFileSync(join(cwd,'target/release-notes.md'),'utf8'),notes+'\n');
  });
});
