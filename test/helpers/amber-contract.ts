// Executable equivalent of Android Intent.parseUri string extras and Amber's
// getIntentDataWithoutExtras/getIntentDataFromIntent/sendResult branches.
// Sources: greenart7c3/Amber tags v3.4.3, v4.0.0, v6.6.9, v7.0.0-pre3,
// app/src/main/java/com/greenart7c3/nostrsigner/service/IntentUtils.kt.
// This models protocol parsing, not the Android resolver or approval UI.
export function parseAndroidIntent(uri: string) {
  const [raw, options] = uri.split('#Intent;');
  if (!raw?.startsWith('intent:') || !options?.endsWith(';end')) throw new Error('Invalid Android intent');
  const extras: Record<string, string> = {};
  const fields = Object.fromEntries(options.slice(0, -4).split(';').map(p => {
    const eq = p.indexOf('='); return [p.slice(0, eq), p.slice(eq + 1)];
  }));
  for (const [key, value] of Object.entries(fields)) if (key.startsWith('S.')) extras[key.slice(2)] = decodeURIComponent(value);
  return { data: `${fields.scheme}:${raw.slice(7)}`, extras, package: fields.package };
}
export function parseAmber(uri: string, version = 'v6.6.9', browserApplicationId = true) {
  const intent = parseAndroidIntent(uri);
  // Old versions only use Browser.EXTRA_APPLICATION_ID. Newer versions also
  // recognize BROWSABLE and type=, unless a native type extra is supplied.
  const modern = ['v6.6.9', 'v7.0.0-pre3'].includes(version);
  const web = browserApplicationId || (modern && !intent.extras.type);
  const encoded = intent.data.replaceAll('nostrsigner:', '');
  const decoded = decodeURIComponent(encoded.replaceAll('+', '%2b'));
  let params: Record<string, string> = {};
  let payload = decoded;
  if (web) {
    const fixedQuery = version === 'v7.0.0-pre3';
    const segments = (fixedQuery ? encoded : decoded).split('?').slice(1).filter(Boolean);
    if (segments.length) {
      payload = decoded.split('?')[0];
      for (const part of segments.flatMap(s => s.split('&'))) {
        const [key, ...rest] = part.split('=');
        params[key] = fixedQuery ? decodeURIComponent(rest.join('=').replaceAll('+', ' ')) : rest.join('=');
      }
    } else params = intent.extras; // Native fallback is supported for browser callers.
  } else params = intent.extras;
  if (!['get_public_key', 'sign_event', 'nip44_encrypt', 'nip44_decrypt'].includes(params.type)) throw new Error('Amber: unknown signer type');
  return { ...intent, params, payload, event: params.type === 'sign_event' ? JSON.parse(payload) : null };
}
export function amberReturn(uri: string, value: string, signedEvent?: unknown, version = 'v6.6.9', applicationId = true) {
  const { params } = parseAmber(uri, version, applicationId);
  if (!params.callbackUrl) throw new Error('Amber would copy to clipboard, not return');
  // Android Uri.encode leaves the same unreserved punctuation as encodeURIComponent.
  return params.callbackUrl + encodeURIComponent(params.returnType === 'event' ? JSON.stringify(signedEvent) : value);
}
