// Web Push without dependencies: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291).

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
}

export interface Vapid {
  privateJwk: JsonWebKey;
  subject: string;
}

/** Public key (uncompressed P-256 point, base64url) for PushManager.subscribe(). */
export function vapidPublicKey(privateJwk: JsonWebKey): string {
  return b64url(concat(new Uint8Array([4]), fromB64url(privateJwk.x!), fromB64url(privateJwk.y!)));
}

/** Sends one push. Returns the push service's HTTP status (404/410 = subscription is gone). */
export async function sendPush(vapid: Vapid, sub: PushSubscriptionJSON, message: PushMessage): Promise<number> {
  const body = await encryptPayload(sub, new TextEncoder().encode(JSON.stringify(message)));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidHeader(vapid, new URL(sub.endpoint).origin),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(24 * 3600),
      urgency: "normal",
    },
    body,
  });
  return res.status;
}

async function vapidHeader(vapid: Vapid, audience: string): Promise<string> {
  const header = b64url(enc(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(
    enc(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject })),
  );
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  // WebCrypto already returns the raw r||s signature that JWS expects
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${vapidPublicKey(vapid.privateJwk)}`;
}

export async function encryptPayload(sub: PushSubscriptionJSON, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPublic = fromB64url(sub.keys.p256dh);
  const authSecret = fromB64url(sub.keys.auth);

  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as SubtleCryptoDeriveKeyAlgorithm, local.privateKey, 256),
  );

  const ikm = await hkdf(authSecret, shared, concat(enc("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const padded = concat(plaintext, new Uint8Array([2])); // single, final record
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, padded));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

const enc = (s: string) => new TextEncoder().encode(s);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function b64url(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
