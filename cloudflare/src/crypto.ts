/**
 * AES-256-GCM encryption for provider API keys stored in D1.
 *
 * Key material comes from the ENCRYPTION_KEY worker secret (32 raw bytes,
 * base64 or hex encoded). Storage layout mirrors the server's node crypto
 * scheme: ciphertext (base64) in encrypted_key, IV (base64) in iv and the
 * GCM tag (base64) in auth_tag.
 */

const encoder = new TextEncoder();

function decodeKeyMaterial(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  const decoded = Uint8Array.from(atob(trimmed), (c) => c.charCodeAt(0));
  if (decoded.byteLength !== 32) throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
  return decoded;
}

async function importKey(raw: string | undefined): Promise<CryptoKey> {
  if (!raw) throw new Error('ENCRYPTION_KEY secret is not configured on this Worker');
  const material = decodeKeyMaterial(raw);
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export interface SealedKey {
  encrypted_key: string;
  iv: string;
  auth_tag: string;
}

export async function sealKey(plaintext: string, encryptionKey: string | undefined): Promise<SealedKey> {
  const key = await importKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // WebCrypto appends the 128-bit tag to the ciphertext; split it so the D1
  // columns match the server's node crypto layout (tag stored separately).
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext)),
  );
  const tagStart = cipher.byteLength - 16;
  return {
    encrypted_key: btoa(String.fromCharCode(...cipher.slice(0, tagStart))),
    iv: btoa(String.fromCharCode(...iv)),
    auth_tag: btoa(String.fromCharCode(...cipher.slice(tagStart))),
  };
}

export async function unsealKey(
  row: { encrypted_key: string; iv: string; auth_tag: string },
  encryptionKey: string | undefined,
): Promise<string> {
  const key = await importKey(encryptionKey);
  const iv = Uint8Array.from(atob(row.iv), (c) => c.charCodeAt(0));
  const tag = atob(row.auth_tag);
  const cipher = atob(row.encrypted_key);
  const combined = new Uint8Array(cipher.length + 16);
  for (let i = 0; i < cipher.length; i++) combined[i] = cipher.charCodeAt(i);
  for (let i = 0; i < 16; i++) combined[cipher.length + i] = tag.charCodeAt(i);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, combined);
  return new TextDecoder().decode(plain);
}
