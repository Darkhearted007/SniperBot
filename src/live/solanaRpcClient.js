const {
  createKeyPairSignerFromBytes,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder
} = require('@solana/web3.js');
const { LAMPORTS_PER_SOL } = require('./constants');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseWalletSecretBytes(secret) {
  const trimmed = String(secret || '').trim();
  if (!trimmed) {
    throw new Error('SOLANA_WALLET_SECRET is empty');
  }
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error('SOLANA_WALLET_SECRET JSON must be an array');
    }
    return Uint8Array.from(parsed);
  }
  const base64Bytes = Buffer.from(trimmed, 'base64');
  if (base64Bytes.length === 64) {
    return Uint8Array.from(base64Bytes);
  }
  throw new Error('SOLANA_WALLET_SECRET must be a 64-byte JSON array or base64 string');
}

async function rpcRequest(fetchImpl, rpcUrl, method, params) {
  const response = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${method}-${Date.now()}`,
      method,
      params
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || `RPC HTTP ${response.status}`);
  }
  if (body.error) {
    throw new Error(body.error.message || `RPC ${method} failed`);
  }
  return body.result;
}

class SolanaRpcClient {
  constructor({
    rpcUrl,
    walletSecret,
    fetchImpl = fetch,
    signerFactory = createKeyPairSignerFromBytes,
    transactionDecoder = getTransactionDecoder()
  }) {
    this.rpcUrl = rpcUrl;
    this.walletSecret = walletSecret;
    this.fetchImpl = fetchImpl;
    this.signerFactory = signerFactory;
    this.transactionDecoder = transactionDecoder;
    this.signer = null;
  }

  async init() {
    if (!this.signer) {
      this.signer = await this.signerFactory(parseWalletSecretBytes(this.walletSecret));
    }
    return this;
  }

  get walletAddress() {
    if (!this.signer) {
      throw new Error('SolanaRpcClient.init() must be called before use');
    }
    return this.signer.address;
  }

  async getBalanceSol() {
    await this.init();
    const result = await rpcRequest(this.fetchImpl, this.rpcUrl, 'getBalance', [
      this.walletAddress,
      { commitment: 'confirmed' }
    ]);
    return Number(result.value) / LAMPORTS_PER_SOL;
  }

  async signAndSendTransaction(base64UnsignedTransaction, { timeoutMs = 60_000, pollIntervalMs = 1_500 } = {}) {
    await this.init();
    const transactionBytes = Buffer.from(base64UnsignedTransaction, 'base64');
    const decodedTransaction = this.transactionDecoder.decode(transactionBytes);
    const [signedTransaction] = await this.signer.signTransactions([decodedTransaction]);
    const encodedWireTransaction = getBase64EncodedWireTransaction(signedTransaction);
    const signature = getSignatureFromTransaction(signedTransaction);

    await rpcRequest(this.fetchImpl, this.rpcUrl, 'sendTransaction', [
      encodedWireTransaction,
      {
        encoding: 'base64',
        preflightCommitment: 'confirmed',
        maxRetries: 3
      }
    ]);

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const statusResult = await rpcRequest(this.fetchImpl, this.rpcUrl, 'getSignatureStatuses', [
        [signature],
        { searchTransactionHistory: true }
      ]);
      const status = statusResult.value && statusResult.value[0];
      if (status?.err) {
        throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
      }
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        return { signature, status };
      }
      await sleep(pollIntervalMs);
    }

    throw new Error(`Timed out waiting for transaction confirmation: ${signature}`);
  }
}

module.exports = { SolanaRpcClient, parseWalletSecretBytes };
