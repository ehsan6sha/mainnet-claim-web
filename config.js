/**
 * Configuration file for RewardEngine Portal
 * Update the contract addresses below with your deployed contract addresses
 */

export const VERSION = '3.0.0';

export const CONFIG = {
    // Reown AppKit (formerly Web3Modal) — wallet connection.
    // Replaces the legacy window.ethereum / wallet_requestPermissions flow.
    // Project ID is public (safe to ship in client code); get one at cloud.reown.com.
    REOWN_PROJECT_ID: "192a8f5e8d1742ea923be485e60f2612",

    // Metadata shown to the user in their wallet during the WalletConnect handshake.
    // `url` must match the page's actual origin in production or some wallets reject the session.
    APP_METADATA: {
        name: "Functionland Reward Engine",
        description: "Claim mining and network rewards for your Fula peer",
        url: "https://claim-web.fula.network",
        icons: ["https://claim-web.fula.network/favicon.ico"]
    },

    // Contract addresses - UPDATED WITH ACTUAL DEPLOYED ADDRESSES
    CONTRACTS: {
        skale: {
            rewardEngine: "0xF7c64248294C45Eb3AcdD282b58675F1831fb047"
        },
        base: {
            rewardEngine: "0x31029f90405fd3D9cB0835c6d21b9DFF058Df45A"
        }
    },
    
    // FULA Token address (same on both networks)
    FULA_TOKEN: {
        address: "0x9e12735d77c72c5C3670636D428f2F3815d8A4cB",
        symbol: "FULA",
        decimals: 18,
        name: "Functionland FULA"
    },
    
    // Network configurations
    NETWORKS: {
        skale: {
            name: "SKALE Mainnet",
            chainId: 2046399126,
            rpcUrl: "https://mainnet.skalenodes.com/v1/elated-tan-skat",
            blockExplorer: "https://elated-tan-skat.explorer.mainnet.skalenodes.com",
            nativeCurrency: {
                name: "sFUEL",
                symbol: "sFUEL",
                decimals: 18
            }
        },
        base: {
            name: "Base Mainnet",
            chainId: 8453,
            rpcUrl: "https://base-rpc.publicnode.com",
            blockExplorer: "https://basescan.org",
            nativeCurrency: {
                name: "Ethereum",
                symbol: "ETH", 
                decimals: 18
            }
        }
    },
    
    // Gas configuration - per network
    GAS_LIMITS: {
        skale: {
            claimRewards: 100000000, // SKALE has free gas and high limits
            checkRewards: 100000
        },
        base: {
            claimRewards: 15000000, // Based on actual tx: 14,215,647 gas used
            checkRewards: 100000
        }
    },
    
    // UI configuration
    UI: {
        defaultNetwork: "skale",
        defaultPoolId: 1,
        autoHideMessages: {
            success: 8000, // 8 seconds
            error: 10000   // 10 seconds
        }
    }
};
