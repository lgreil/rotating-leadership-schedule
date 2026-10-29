import { afterEach, describe, expect, it, vi } from "vitest";
import { b64url, encryptPayload, fromB64url, sendPush, vapidPublicKey } from "./push";

const enc = (s: string) => new TextEncoder().encode(s);

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** A browser-side subscription: what the user agent would hold. */
async function browser() {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", keys.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = { endpoint: "https://push.example.test/abc", keys: { p256dh: b64url(publicRaw), auth: b64url(auth) } };

  // RFC 8291 decryption, independent of the sender's code path
  async function decrypt(body: Uint8Array): Promise<string> {
    const salt = body.slice(0, 16);
    const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
    const idlen = body[20];
    const asPublic = body.slice(21, 21 + idlen);
    expect(rs).toBe(4096);
    const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as SubtleCryptoDeriveKeyAlgorithm, keys.privateKey, 256));
    const info = new Uint8Array([...enc("WebPush: info\0"), ...publicRaw, ...asPublic]);
    const ikm = await hkdf(auth, shared, info, 32);
    const cek = await hkdf(salt, ikm, enc("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, enc("Content-Encoding: nonce\0"), 12);
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idlen)),
    );
    expect(plain[plain.length - 1]).toBe(2); // last-record delimiter
    return new TextDecoder().decode(plain.slice(0, -1));
  }
  return { sub, decrypt };
}

async function vapidKey() {
  const { privateKey } = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return crypto.subtle.exportKey("jwk", privateKey) as Promise<JsonWebKey>;
}

afterEach(() => vi.unstubAllGlobals());

describe("web push", () => {
  it("encrypts payloads the browser can decrypt", async () => {
    const { sub, decrypt } = await browser();
    const body = await encryptPayload(sub, enc('{"title":"Hallo ✓"}'));
    expect(await decrypt(body)).toBe('{"title":"Hallo ✓"}');
  });

  it("sends a VAPID-signed request the push service can verify", async () => {
    const { sub, decrypt } = await browser();
    const jwk = await vapidKey();
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const status = await sendPush({ privateJwk: jwk, subject: "mailto:test@example.invalid" }, sub, {
      title: "T",
      body: "B",
    });
    expect(status).toBe(201);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(sub.endpoint);
    const headers = init.headers as Record<string, string>;
    expect(headers["content-encoding"]).toBe("aes128gcm");
    expect(JSON.parse(await decrypt(init.body as Uint8Array))).toEqual({ title: "T", body: "B" });

    const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(headers.authorization)!;
    expect(k).toBe(vapidPublicKey(jwk));
    const [h, c, s] = token.split(".");
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(c)));
    expect(claims.aud).toBe("https://push.example.test");
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);

    const pub = await crypto.subtle.importKey("raw", fromB64url(k), { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromB64url(s), enc(`${h}.${c}`));
    expect(valid).toBe(true);
  });
});
