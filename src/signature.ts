/** Verify LINE's signature against the exact bytes received, before JSON parsing. */
export async function verifySignature(raw: ArrayBufferLike, signature: string | null, secret: string): Promise<boolean> {
  if (!signature || !secret || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) return false;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const bytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
    return await crypto.subtle.verify('HMAC', key, bytes, new Uint8Array(raw));
  } catch { return false; }
}
