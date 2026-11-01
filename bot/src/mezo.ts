import { createPublicClient, defineChain, http, parseAbi } from "viem";
import { config } from "./config.ts";

/** Mezo testnet ("matsnet"). Addresses from mezo-org/musd deployments, read back on-chain. */
export const mezoTestnet = defineChain({
  id: 31611,
  name: "Mezo Testnet",
  nativeCurrency: { name: "Bitcoin", symbol: "BTC", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
  blockExplorers: { default: { name: "Mezo Explorer", url: "https://explorer.test.mezo.org" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const addresses = {
  musd: "0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503",
  troveManager: "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0",
  borrowerOperations: "0xCdF7028ceAB81fA0C6971208e83fa7872994beE5", // BorrowerOperationsSignatures.borrowerOperations()
  borrowerOperationsSignatures: "0xD757e3646AF370b15f32EB557F0F8380Df7D639e",
  priceFeed: "0x86bCF0841622a5dAC14A313a15f96A95421b9366",
  vigilReserve: config.vigilReserve,
} as const;

export const priceFeedAbi = parseAbi(["function fetchPrice() view returns (uint256)"]);

export const troveManagerAbi = parseAbi([
  "function getTroveOwnersCount() view returns (uint256)",
  "function getTroveFromTroveOwnersArray(uint256 index) view returns (address)",
  "function getEntireDebtAndColl(address borrower) view returns (uint256 coll, uint256 principal, uint256 interest, uint256 pendingCollateral, uint256 pendingPrincipal, uint256 pendingInterest)",
  "function getTroveInterestRate(address borrower) view returns (uint16)",
  "function getTroveStatus(address borrower) view returns (uint8)",
  "function getCurrentICR(address borrower, uint256 price) view returns (uint256)",
  "function MCR() view returns (uint256)",
  "function CCR() view returns (uint256)",
  "function getTCR(uint256 price) view returns (uint256)",
  "function checkRecoveryMode(uint256 price) view returns (bool)",
]);

/** minNetDebt is set by Mezo governance (proposeMinNetDebt / approveMinNetDebt), so read it, never assume it. */
export const borrowerOpsAbi = parseAbi([
  "function minNetDebt() view returns (uint256)",
  "function MUSD_GAS_COMPENSATION() view returns (uint256)",
]);

export const sigOpsAbi = parseAbi([
  "function getNonce(address user) view returns (uint256)",
]);

export const musdAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const vigilAbi = parseAbi([
  "function reserveOf(address) view returns (uint256)",
  "function triggerOf(address) view returns (uint256)",
  "function deposit(address borrower, uint256 amount)",
  "function withdraw(uint256 amount, address to)",
  "function setTrigger(uint256 triggerICR)",
  "function canRescue(address borrower, uint256 amount) view returns (bool ok, uint256 icr, uint256 price)",
  "function rescue(address borrower, uint256 amount, uint256 deadline, bytes signature, address upperHint, address lowerHint)",
  "event Rescued(address indexed borrower, address indexed keeper, uint256 amount, uint256 price, uint256 icrBefore, uint256 icrAfter)",
  "error ZeroAmount()",
  "error TriggerTooLow(uint256 trigger)",
  "error RescueOff()",
  "error TroveNotActive()",
  "error ReserveTooSmall(uint256 reserve, uint256 amount)",
  "error AboveTrigger(uint256 icr, uint256 trigger)",
  "error BurnMismatch(uint256 expected, uint256 actual)",
  "error TransferFailed()",
]);

/** EIP-712 domain and type Mezo uses for a signed repay (BorrowerOperationsSignatures). */
export const repayTypedData = {
  domain: {
    name: "BorrowerOperationsSignatures",
    version: "1",
    chainId: mezoTestnet.id,
    verifyingContract: addresses.borrowerOperationsSignatures,
  },
  types: {
    RepayMUSD: [
      { name: "amount", type: "uint256" },
      { name: "borrower", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "RepayMUSD",
} as const;

export const TROVE_ACTIVE = 1;

export const client = createPublicClient({
  chain: mezoTestnet,
  transport: http(config.rpcUrl, { batch: false, retryCount: 3, timeout: 20_000 }),
});

export const explorerTx = (hash: string) => `https://explorer.test.mezo.org/tx/${hash}`;
export const explorerAddress = (address: string) => `https://explorer.test.mezo.org/address/${address}`;
