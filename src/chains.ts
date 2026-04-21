export type Chain = { id: number; name: string; symbol: string; rpcUrl: string; explorerUrl: string };

export const CHAINS: Chain[] = [
  { id: 56, name: "BNB Smart Chain", symbol: "BNB", rpcUrl: "https://bsc-dataseed.bnbchain.org", explorerUrl: "https://bscscan.com" },
  { id: 1, name: "Ethereum", symbol: "ETH", rpcUrl: "https://eth.llamarpc.com", explorerUrl: "https://etherscan.io" },
  { id: 8453, name: "Base", symbol: "ETH", rpcUrl: "https://mainnet.base.org", explorerUrl: "https://basescan.org" },
  { id: 42161, name: "Arbitrum One", symbol: "ETH", rpcUrl: "https://arb1.arbitrum.io/rpc", explorerUrl: "https://arbiscan.io" },
  { id: 10, name: "Optimism", symbol: "ETH", rpcUrl: "https://mainnet.optimism.io", explorerUrl: "https://optimistic.etherscan.io" },
  { id: 137, name: "Polygon", symbol: "MATIC", rpcUrl: "https://polygon-rpc.com", explorerUrl: "https://polygonscan.com" }
];

export function findChain(id: number): Chain | undefined {
  return CHAINS.find((c) => c.id === id);
}
