/**
 * Configuration file for RewardEngine Portal
 * Update the contract addresses below with your deployed contract addresses
 */

export const VERSION = '2.0.0';

export const CONFIG = {
    // Contract addresses - UPDATED WITH ACTUAL DEPLOYED ADDRESSES
    CONTRACTS: {
        skale: {
            rewardEngine: "0xF7c64248294C45Eb3AcdD282b58675F1831fb047"
        },
        base: {
            rewardEngine: "0x31029f90405fd3D9cB0835c6d21b9DFF058Df45A"
        }
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
