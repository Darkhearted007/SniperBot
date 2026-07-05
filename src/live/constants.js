const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';
const LAMPORTS_PER_SOL = 1_000_000_000;
const DEFAULT_JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6';
const DEFAULT_JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6';

// Token/native program owned by the SPL Token program; used to recognize
// standard token accounts when parsing getTokenLargestAccounts results.
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Addresses that effectively destroy tokens sent to them. Seeing LP tokens
// (or a meaningful share of supply) parked here is a strong "burned, not
// rug-pullable" signal.
const KNOWN_BURN_ADDRESSES = [
  '1nc1nerator11111111111111111111111111111111',
  '11111111111111111111111111111111111111111'
];

// Well-known LP/token locker programs. If the largest holder of an LP mint
// is an account owned by one of these programs, liquidity is contractually
// locked rather than sitting in a wallet the deployer can drain.
const KNOWN_LOCKER_PROGRAM_IDS = [
  'FoQ4d1Y6Snm71ryecwRBqPDL9wcnkCcbSVN1oCyRJ6Bw', // Streamflow token vesting/lock
  'LocktDzaV1W2Bm9DeZeiyz4J9zs4fRqNiYqQyracRXw' // Generic community LP locker placeholder; override via config
];

// Program IDs that new pool/pair discovery watches for creation events.
// These can drift as venues upgrade programs, so they're overridable via
// POOL_DISCOVERY_PROGRAMS.
const RAYDIUM_AMM_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CPMM_PROGRAM_ID = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

module.exports = {
  NATIVE_SOL_MINT,
  LAMPORTS_PER_SOL,
  DEFAULT_JUPITER_QUOTE_API,
  DEFAULT_JUPITER_SWAP_API,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  KNOWN_BURN_ADDRESSES,
  KNOWN_LOCKER_PROGRAM_IDS,
  RAYDIUM_AMM_V4_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID,
  PUMP_FUN_PROGRAM_ID
};
