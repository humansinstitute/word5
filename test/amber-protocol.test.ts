import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseAmber, amberReturn } from './helpers/amber-contract';

// Run the actual shipped adapter and click its real Open Amber handler.
function adapter() {
  const elements = new Map<string, any>(), storage = new Map<string, string>();
  const document = { body: { appendChild(e: any) { elements.set(e.id, e); } },
    getElementById: (id: string) => elements.get(id), addEventListener() {},
    createElement: () => ({ children: [] as any[], style: {}, setAttribute() {},
      append(...e: any[]) { this.children.push(...e); }, remove() { for (const [k, v] of elements) if (v === this) elements.delete(k); } }) };
  const player = { auth_mode: 'amber', linked_pubkey: 'a'.repeat(64) };
  const location = { pathname: '/word5/', origin: 'https://otherstuff.ai', href: '', hash: '' };
  const window = { NostrSession: { getPlayer: () => player }, addEventListener() {} } as any;
  runInNewContext(readFileSync('js/amber-signer.js', 'utf8'), { window, document, location, URL, URLSearchParams, crypto,
    localStorage: { getItem: (k: string) => storage.get(k), setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) } });
  return { window, location, storage, open: () => elements.get('amberRequest').children[1].onclick(),
    manual: () => { const panel = elements.get('amberRequest'); panel.children[2].onclick(); panel.children[3].children[1].onclick(); } };
}
const versions = ['v3.4.3', 'v4.0.0', 'v6.6.9', 'v7.0.0-pre3'];
test('released Amber reproduces the previous outgoing URI callback truncation', () => {
  const callback = 'https://otherstuff.ai/word5/#amber-state=nonce&amber-result=';
  const query = new URLSearchParams({ type: 'get_public_key', callbackUrl: callback, returnType: 'signature' });
  const old = `intent:?${query}#Intent;scheme=nostrsigner;package=com.greenart7c3.nostrsigner;end`;
  for (const version of versions.slice(0, 3)) {
    const returned = new URL(amberReturn(old, 'a'.repeat(64), undefined, version));
    expect(returned.hash).toBe('#amber-state=nonce' + 'a'.repeat(64));
    expect(new URLSearchParams(returned.hash.slice(1)).has('amber-result')).toBe(false);
    if (version !== 'v6.6.9') expect(() => parseAmber(old, version, false)).toThrow('unknown signer type');
  }
  expect(new URL(amberReturn(old, 'a'.repeat(64), undefined, versions[3])).hash).toContain('&amber-result=');
});
test('actual Open Amber URI preserves callback and account through released parsers with/without browser application ID', () => {
  const a = adapter(); a.window.AmberSigner.login(); a.open();
  const request = JSON.parse(a.storage.get('word5-amber-pending-v1')!);
  for (const version of versions) for (const applicationId of [true, false]) {
    const parsed = parseAmber(a.location.href, version, applicationId);
    expect(parsed.params.type).toBe('get_public_key');
    expect(parsed.package).toBe('com.greenart7c3.nostrsigner');
    const returned = new URL(amberReturn(a.location.href, 'a'.repeat(64), undefined, version, applicationId));
    const fragment = new URLSearchParams(returned.hash.slice(1));
    expect(fragment.get('amber-state')).toBe(request.id);
    expect(fragment.get('amber-result')).toBe('a'.repeat(64));
  }
});
test('actual signing URI preserves JSON punctuation, percent escapes, Unicode and exact current_user', () => {
  const a = adapter();
  const event = { kind: 1, created_at: 123, content: 'Question? a&b + %26 %3F # ; = 🧡 nostrsigner:', tags: [['x', '?&+=#;']] };
  void a.window.AmberSigner.signEvent(event); a.open();
  const pending = JSON.parse(a.storage.get('word5-amber-pending-v1')!);
  for (const version of versions) for (const applicationId of [true, false]) {
    const parsed = parseAmber(a.location.href, version, applicationId);
    expect(parsed.event).toEqual(pending.event);
    expect(parsed.params.current_user).toBe('a'.repeat(64));
    expect(parsed.params.returnType).toBe('event');
    const returned = new URL(amberReturn(a.location.href, 'signature', pending.event, version, applicationId));
    expect(JSON.parse(new URLSearchParams(returned.hash.slice(1)).get('amber-result')!)).toEqual(pending.event);
  }
});

test('manual mode launches actual request without callback and requests public key or full event', () => {
  for (const signing of [false, true]) {
    const a = adapter();
    if (signing) void a.window.AmberSigner.signEvent({ kind: 1, created_at: 123, content: 'Copy? & %', tags: [] });
    else a.window.AmberSigner.login();
    a.manual();
    const request = JSON.parse(a.storage.get('word5-amber-pending-v1')!);
    expect(request.manual).toBe(true);
    for (const version of versions) for (const applicationId of [true, false]) {
      const parsed = parseAmber(a.location.href, version, applicationId);
      expect(parsed.params.callbackUrl).toBeUndefined();
      expect(parsed.params.type).toBe(signing ? 'sign_event' : 'get_public_key');
      expect(parsed.params.returnType).toBe(signing ? 'event' : 'signature');
      if (signing) expect(parsed.event).toEqual(request.event);
    }
  }
});
