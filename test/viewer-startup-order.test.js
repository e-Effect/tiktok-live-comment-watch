import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('attention state is initialized before first synchronous viewer render',()=>{
  const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const firstRender=source.indexOf('\nrenderSelectedSession();');
  assert.ok(firstRender>0);
  for(const declaration of ['const attentionBySession = new Map();','let attentionTimer;']) {
    assert.ok(source.indexOf(declaration)>=0 && source.indexOf(declaration)<firstRender);
  }
});
