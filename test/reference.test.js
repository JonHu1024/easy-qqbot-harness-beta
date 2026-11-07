import test from 'node:test';
import assert from 'node:assert/strict';
import { QQClient, normalizeEvent } from '../src/qq.js';

const client = () => new QQClient({ getConfig: () => ({ qq: { appId: 'app', appSecret: 'unused' } }) });
const payload = d => ({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'current', group_openid: 'group', author: { member_openid: 'user', username: '小明' }, content: 'current instruction', ...d } });

test('normalization selects only exact ref index and never keeps auth token', () => {
  const event = normalizeEvent(payload({ message_type: 103, message_scene: { ext: ['msg_idx=current==', 'ref_msg_idx=quote==', 'auth_token=secret'] }, msg_elements: [
    { msg_idx: 'other', content: 'not this quote' },
    { msg_idx: 'container', msg_elements: [{ msg_idx: 'quote==', content: 'actual quote', author: { member_openid: 'quoted-user' }, attachments: [{ url: 'https://multimedia.nt.qq.com.cn/download?rkey=ephemeral', filename: 'x.jpg', content_type: 'image/jpeg', size: 200, auth_token: 'secret' }] }] },
  ] }));
  assert.equal(event.content, 'current instruction');
  assert.equal(event.senderName, '小明');
  assert.equal(event.messageIndex, 'current==');
  assert.equal(event.reference.refIndex, 'quote==');
  assert.equal(event.reference.source, 'event');
  assert.equal(event.reference.content, 'actual quote');
  assert.equal(event.reference.authorId, 'quoted-user');
  assert.equal(event.reference.attachments[0].contentType, 'image/jpeg');
  assert.doesNotMatch(JSON.stringify(event), /auth_token|secret|not this quote/);
});

test('unindexed or unmatched group transcript is not guessed as reference', () => {
  for (const msg_elements of [[{ content: 'unindexed merged transcript' }], [{ msg_idx: 'other', content: 'wrong' }]]) {
    const event = normalizeEvent(payload({ message_type: 103, message_scene: { ext: ['ref_msg_idx=desired'] }, msg_elements }));
    assert.equal(event.reference.source, 'unavailable');
    assert.equal(event.reference.content, undefined);
  }
  const cyclic = { msg_idx: 'other' }; cyclic.msg_elements = [cyclic];
  assert.equal(normalizeEvent(payload({ message_type: 103, message_scene: { ext: ['ref_msg_idx=desired'] }, msg_elements: [cyclic] })).reference.source, 'unavailable');
});

test('attachment-only messages survive normalization', () => {
  const event = normalizeEvent(payload({ content: '', attachments: [{ url: 'https://example.com/a.png', content_type: 'image/png', filename: 'a.png' }] }));
  assert.equal(event.content, '');
  assert.equal(event.attachments.length, 1);
});

test('inline reference has priority without store or remote access', async () => {
  const c = client();
  c.request = () => { throw new Error('unexpected remote lookup'); };
  const event = normalizeEvent(payload({ message_type: 103, message_scene: { ext: ['ref_msg_idx=r'] }, msg_elements: [{ msg_idx: 'r', content: 'quote' }] }));
  const enriched = await c.resolveReference(event, { findReferencedMessage: () => { throw new Error('unexpected local lookup'); } });
  assert.notEqual(enriched, event);
  assert.notEqual(enriched.reference, event.reference);
  assert.equal(enriched.reference.source, 'event');
});

test('local lookup includes complete app/scene/target/user owner and message identifiers', async () => {
  const c = client();
  c.request = () => { throw new Error('v2 must not fetch'); };
  const event = { scene: 'group', targetId: 'g', userId: 'u', reference: { messageId: 'm', refIndex: 'r', source: 'unavailable' } };
  const enriched = await c.resolveReference(event, { findReferencedMessage: query => {
    assert.deepEqual(query, { appId: 'app', scene: 'group', targetId: 'g', userId: 'u', messageId: 'm', refIndex: 'r' });
    return { content: 'stored quote', authorId: 'u', attachments: [] };
  } });
  assert.equal(enriched.reference.source, 'local');
  assert.equal(enriched.reference.content, 'stored quote');
  assert.equal(event.reference.source, 'unavailable');
});

test('only channel reference uses documented GET and validates response identity/target', async () => {
  const event = { scene: 'channel', targetId: 'ch', userId: 'u', reference: { messageId: 'm', source: 'unavailable' } };
  const c = client();
  c.request = async (method, path) => {
    assert.equal(method, 'GET'); assert.equal(path, '/channels/ch/messages/m');
    return { message: { id: 'm', channel_id: 'ch', content: 'channel quote', author: { id: 'other-user' } } };
  };
  assert.equal((await c.resolveReference(event, { findReferencedMessage: () => null })).reference.source, 'api');
  c.request = async () => ({ id: 'm', channel_id: 'other-channel', content: 'must not use' });
  assert.equal((await c.resolveReference(event, { findReferencedMessage: () => null })).reference.source, 'unavailable');
  c.request = async () => { throw new Error('permission denied'); };
  assert.equal((await c.resolveReference(event, { findReferencedMessage: () => null })).reference.source, 'unavailable');
});

test('v2 and guild DM have explicit unavailable state with no invented endpoint', async () => {
  const c = client(); c.request = () => { throw new Error('unsupported remote endpoint'); };
  for (const scene of ['c2c', 'group', 'dm']) {
    const enriched = await c.resolveReference({ scene, targetId: 'target', userId: 'u', reference: { messageId: 'm', source: 'unavailable', content: 'stale' } }, { findReferencedMessage: () => null });
    assert.equal(enriched.reference.source, 'unavailable');
    assert.equal(enriched.reference.content, undefined);
  }
});
