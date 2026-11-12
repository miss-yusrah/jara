// Shared by the browser (to sign) and the server (to verify): keep byte-for-byte identical.
export function walletClaimerMessage(userId: string, owner: string, claimer: string, issuedAt: number) {
  return `Activate my Jara claim contract\n\nAccount: ${userId}\nOwner: ${owner.toLowerCase()}\nClaim contract: ${claimer.toLowerCase()}\nChain: 42220\nTime: ${new Date(issuedAt).toISOString()}\n\nLink this Jara account to my claim contract. Daily claims go only to my wallet. This signature does not grant spending permission.`
}

/** Signed by the verified GoodDollar wallet to reveal the key of the Jara wallet it owns. */
export function walletKeyExportMessage(owner: string, jaraWallet: string, issuedAt: number) {
  return `Show my Jara wallet key\n\nJara wallet: ${jaraWallet}\nOwner: ${owner}\nTime: ${new Date(issuedAt).toISOString()}\n\nOnly sign this on Jara itself. Anyone who sees the key can move the G$ held in your Jara wallet. This signature costs nothing and moves no money.`
}

export function walletLoginMessage(address: string, issuedAt: number) {
  return `Sign in to Jara\n\nWallet: ${address}\nTime: ${new Date(issuedAt).toISOString()}\n\nThis only proves the wallet is yours. It costs nothing and moves no money.`
}
