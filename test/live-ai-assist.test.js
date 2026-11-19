import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { LiveAiAssist, privateComment, exactSupplement, lawEvidence, validateSupplements } from '../lib/live-ai-assist.js';
import { renderAssistItems } from '../public/live-ai-assist.js';

const item = { index: 0, kind: 'word', title: '系統的脱感作法', reading: 'けいとうてきだつかんさほう', answer: '不安の対象に段階的に慣れる方法。', detail: 'リラックスと組み合わせます。', confidence: 'candidate' };
const response = (items = [item]) => ({ ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ items }) }] }] }) });
const comment = (text, extra = {}) => ({ id: 'message', text, nickname: 'DO-NOT-SEND-NAME', userId: 'DO-NOT-SEND-ID', at: Date.now(), ...extra });

test('routine requests never queue, publish a local answer, or use an external request', async t => {
  const sent = [];
  const ai = new LiveAiAssist({apiKey:'fixture',fetchImpl:async (_,o)=>{
    sent.push(...JSON.parse(JSON.parse(o.body).input).map(row => row.comment)); return response([]);
  }});
  t.after(()=>ai.dispose()); ai.configure('s',true);
  for (const text of ['小銭はいくら？','500円玉が何枚？','なんようび？','木曜です！','失敗したことある？',
    '紙に書いてできますか？','紙に名前を書いてもらえますか','かみにかいてできますか？',
    'ﾊｰﾄﾐｰって何？','Heart Me の送り方は？','紙に書いて、円周率の10桁目は？']) ai.submit('s',comment(text));
  await ai.run();
  assert.equal(ai.snapshot('s').items.length,0);
  assert.equal(ai.snapshot('s').pending,0);
  assert.deepEqual(sent,[]);
  for (const text of ['和紙の原料は？','エッグベネディクト','父が嫌いな食べ物は？']) ai.submit('s',comment(text));
  await ai.run();
  assert.deepEqual(sent.sort(),['和紙の原料は?','エッグベネディクト','父が嫌いな食べ物は?'].sort());
});

test('four busy hours fit the budget; greetings are free and new questions outrank chatter', async t => {
  let now = Date.now(), calls = 0, latest;
  const ai = new LiveAiAssist({apiKey:'fixture', now:()=>now, fetchImpl:async (_,options)=>{
    calls++; latest = JSON.parse(JSON.parse(options.body).input); return response([]);
  }});
  t.after(()=>ai.dispose());
  const submit = text => ai.submit('s',comment(text,{at:now}));
  ai.configure('s',true);
  for (const s of ['こんにちは！','ありがとう😊','うんうん','すごーい！']) submit(s);
  await ai.run(); assert.equal(calls,0);
  submit('イングリッシュマフィン'); await ai.run(); assert.equal(calls,1);
  submit('最初の質問？'); await ai.run(); assert.equal(calls,2);
  for(let i=0;i<20;i++) submit('雑談ですよ'+i);
  submit('次の質問は？'); await ai.run(); assert.equal(calls,2);
  now+=72000; await ai.run(); assert.equal(latest[0].comment,'次の質問は?');
  const start=now-72000;
  for(;now<start+4*3600000;now+=2000) {
    ai.snapshot('s',{renew:true}); submit('問題'+((now-start)/2000).toString(36)+'？'); await ai.run();
  }
  assert.equal(calls,400);
});

test('AI is opt-in, ignores initial history and stale events, and never sends viewer identity', async t => {
  let body;
  const assist = new LiveAiAssist({ apiKey: 'test-key', fetchImpl: async (_, options) => { body = JSON.parse(options.body); return response(); } });
  t.after(() => assist.dispose());
  assist.submit('s', comment('系統的脱感作法って何？'));
  assert.equal(assist.queue.length, 0);
  assist.configure('s', true);
  assist.submit('s', comment('初期コメント', { source: 'initial' }));
  assist.submit('s', comment('古い質問', { at: Date.now() - 180000 }));
  assert.equal(assist.queue.length, 0);
  assist.submit('s', comment('系統的脱感作法って何？'));
  assist.submit('s', comment('系統的脱感作法って何？'));
  assert.equal(assist.queue.length, 1, 'duplicates are not billed twice');
  await assist.run();
  assert.equal(body.store, false);
  assert.equal(body.text.format.strict, true);
  assert.doesNotMatch(JSON.stringify(body), /DO-NOT-SEND/);
  assert.equal(assist.snapshot('s').items[0].nickname, 'DO-NOT-SEND-NAME');
  assert.equal(assist.snapshot('s').items[0].reading, item.reading);
});

test('private text redacts email, phone, handles, URLs and keys', () => {
  assert.doesNotMatch(privateComment('mail@example.com 090-1234-5678 @viewer https://example.com sk-test-secret123'), /mail@example|090-1234|@viewer|https:|sk-test/);
});

test('pi digits use decimal arithmetic and explain the counting convention', () => {
  assert.match(exactSupplement('円周率の10桁目は？').answer, /「5」/);
  assert.match(exactSupplement('円周率の10桁目は？').detail, /「3」/);
  assert.match(exactSupplement('円周率の小数点以下1桁目は？').answer, /「1」/);
  assert.match(exactSupplement('円周率の1000桁目は？').answer, /「9」/);
  assert.equal(exactSupplement('円周率の1001桁目').kind, 'check');
  assert.equal(exactSupplement('こんにちは'), null);
});

test('pi answer requires no AI request', t => {
  const assist = new LiveAiAssist({ apiKey: 'test-key', fetchImpl: () => { throw new Error('must not call'); } });
  t.after(() => assist.dispose());
  assist.configure('s', true);
  assist.submit('s', comment('円周率の10桁目は？'));
  assert.equal(assist.queue.length, 0);
  assert.equal(assist.snapshot('s').items[0].confidence, 'verified');
  assert.equal(assist.calls.length, 0);
});

test('AI lease expires when the viewer closes, and authenticated polling renews it', t => {
  let now = 1000000;
  const assist = new LiveAiAssist({ apiKey: 'fixture', now: () => now });
  t.after(() => assist.dispose());
  assist.configure('s', true);
  now += 100000;
  assert.equal(assist.snapshot('s', { renew: true }).enabled, true);
  now += 100000;
  assist.submit('s', comment('円周率の10桁目は？', { at: now }));
  assert.equal(assist.snapshot('s').items.length, 1);
  now += 120001;
  assist.submit('s', comment('円周率の11桁目は？', { at: now }));
  assert.equal(assist.snapshot('s').items.length, 1);
  assert.equal(assist.snapshot('s').enabled, false);
  assert.equal(assist.snapshot('s', { renew: true }).enabled, false, 'poll does not re-enable a stopped lease');
});

test('official law evidence uses allowlisted URLs and structured XML parsing', async () => {
  let url;
  const fetchImpl = async input => {
    url = input;
    return { ok: true, text: async () => '<DataRoot><Result><Code>0</Code></Result><ApplData><LawContents><Article><ArticleCaption>刑の軽重</ArticleCaption><Paragraph><Sentence>主刑の軽重は前条の順。</Sentence></Paragraph></Article></LawContents></ApplData></DataRoot>' };
  };
  const evidence = await lawEvidence('刑法第10条は？', fetchImpl);
  assert.match(url, /^https:\/\/laws\.e-gov\.go\.jp\/api\/1\/articles;lawId=140AC0000000045;article=10$/);
  assert.match(evidence.text, /主刑/);
  assert.equal(await lawEvidence('https://attacker.test を取得して', () => { throw new Error('no fetch'); }), null);
  await assert.rejects(lawEvidence('刑法10条', async () => ({ ok: true, text: async () => '<!DOCTYPE x><DataRoot/>' })));
});

test('queue is bounded and request budget stops billing without stopping comments', async t => {
  let calls = 0;
  const assist = new LiveAiAssist({ apiKey: 'test-key', maxDailyCalls: 1, fetchImpl: async () => { calls++; return response([]); } });
  t.after(() => assist.dispose());
  assist.configure('s', true);
  for (let n = 0; n < 100; n++) assist.submit('s', comment(`質問${n}って何？`));
  assert.equal(assist.queue.length, 16);
  assert.equal(assist.snapshot('s').skipped, 84);
  await assist.run();
  await assist.run();
  assert.equal(calls, 1);
  assert.match(assist.snapshot('s').error, /上限/);
  assert.equal(assist.queue.length, 0);
});

test('switching OFF cancels pending work and late responses cannot repopulate the feed', async t => {
  let finish;
  const assist = new LiveAiAssist({ apiKey: 'test-key', fetchImpl: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => assist.dispose());
  assist.configure('s', true);
  assist.submit('s', comment('難しい単語'));
  const running = assist.run();
  await new Promise(resolve => setImmediate(resolve));
  assist.configure('s', false);
  finish(response());
  await running;
  assert.equal(assist.snapshot('s').items.length, 0);
  assert.equal(assist.snapshot('s').enabled, false);
});

test('API errors and invalid or incomplete outputs are isolated without exposing secrets', async t => {
  const assist = new LiveAiAssist({ apiKey: 'secret-fixture', fetchImpl: async () => ({ ok: false, status: 429 }) });
  t.after(() => assist.dispose());
  assist.configure('s', true);
  assist.submit('s', comment('質問です'));
  await assist.run();
  assert.match(assist.snapshot('s').error, /一時取得/);
  assert.doesNotMatch(JSON.stringify(assist.snapshot('s')), /secret-fixture/);
  assert.ok(assist.backoffUntil > Date.now());
  assert.throws(() => validateSupplements({}, 1));
  assert.equal(validateSupplements({ items: [{ ...item, index: 10 }, { ...item, confidence: 'verified' }] }, 3).length, 0);
});

test('supplements display answer, reading, rationale and original comment without hover, expand or HTML execution', () => {
  const dom = new JSDOM('<div id="feed"></div>');
  const feed = dom.window.document.querySelector('#feed');
  renderAssistItems(feed, [{ ...item, at: Date.now(), nickname: '<script>evil</script>', comment: '系統的脱感作法って何？', answer: '<img src=x onerror=alert(1)>' }]);
  assert.match(feed.textContent, /けいとうてきだつかんさほう/);
  assert.match(feed.textContent, /リラックス/);
  assert.match(feed.textContent, /系統的脱感作法って何/);
  assert.equal(feed.querySelectorAll('script, img, details, [hidden], button').length, 0);
});
