// Generates a VAPID key pair for Web Push.
// Usage: node scripts/vapid.mjs   -> prints the value for the VAPID_PRIVATE_JWK secret
const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", privateKey);
console.log(JSON.stringify({ kty, crv, x, y, d }));
