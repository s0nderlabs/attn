import { privateKeyToAccount } from 'viem/accounts'
import { recoverMessageAddress } from 'viem'
import { encrypt, decrypt } from 'eciesjs'

export function deriveIdentity(privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey)
  return {
    address: account.address.toLowerCase(),
    account,
  }
}

export function encryptMessage(recipientPublicKey: string, plaintext: string): string {
  // eciesjs accepts hex string directly
  const pubKeyHex = recipientPublicKey.startsWith('0x') ? recipientPublicKey.slice(2) : recipientPublicKey
  const data = new TextEncoder().encode(plaintext)
  const encrypted = encrypt(pubKeyHex, data)
  return Buffer.from(encrypted).toString('base64')
}

export function decryptMessage(privateKey: `0x${string}`, encrypted: string): string {
  const privKeyHex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey
  const data = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0))
  const decrypted = decrypt(privKeyHex, data)
  return new TextDecoder().decode(decrypted)
}

function serializeEnvelope(envelope: { id: string; to: string; encrypted: string }): string {
  return JSON.stringify({ id: envelope.id, to: envelope.to, encrypted: envelope.encrypted })
}

export async function signEnvelope(
  account: ReturnType<typeof privateKeyToAccount>,
  envelope: { id: string; to: string; encrypted: string },
): Promise<string> {
  return account.signMessage({ message: serializeEnvelope(envelope) })
}

export async function verifyEnvelope(
  from: string,
  envelope: { id: string; to: string; encrypted: string },
  signature: `0x${string}`,
): Promise<boolean> {
  try {
    const recovered = await recoverMessageAddress({ message: serializeEnvelope(envelope), signature })
    return recovered.toLowerCase() === from.toLowerCase()
  } catch {
    return false
  }
}
