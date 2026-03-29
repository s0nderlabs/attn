import { recoverMessageAddress, recoverPublicKey, hashMessage, type Hex } from 'viem'

export async function verifyAuth(
  nonce: string,
  address: string,
  signature: Hex,
): Promise<{ valid: boolean; publicKey?: string; reason?: string }> {
  try {
    const recovered = await recoverMessageAddress({ message: nonce, signature })

    if (recovered.toLowerCase() !== address.toLowerCase()) {
      return { valid: false, reason: 'signature does not match claimed address' }
    }

    const hash = hashMessage(nonce)
    const publicKey = await recoverPublicKey({ hash, signature })

    return { valid: true, publicKey }
  } catch (err) {
    return { valid: false, reason: err instanceof Error ? err.message : 'verification failed' }
  }
}
