// Shared by the browser (to sign) and the server (to verify): keep byte-for-byte identical.
export function walletLoginMessage(address: string, issuedAt: number) {
  return `Sign in to Jara\n\nWallet: ${address}\nTime: ${new Date(issuedAt).toISOString()}\n\nThis only proves the wallet is yours. It costs nothing and moves no money.`
}
