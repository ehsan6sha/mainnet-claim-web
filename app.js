// Import ethers v6 from CDN
import { ethers } from "https://cdnjs.cloudflare.com/ajax/libs/ethers/6.7.0/ethers.min.js";
// Import configuration and ABI
import { CONFIG, VERSION } from "./config.js";
import { REWARD_ENGINE_ABI } from "./abi.js";

// Network configurations from config
const NETWORKS = {
    skale: {
        ...CONFIG.NETWORKS.skale,
        rewardEngineAddress: CONFIG.CONTRACTS.skale.rewardEngine
    },
    base: {
        ...CONFIG.NETWORKS.base,
        rewardEngineAddress: CONFIG.CONTRACTS.base.rewardEngine
    }
};

// Gas limits from config
const GAS_LIMITS = CONFIG.GAS_LIMITS;

// Claim periods configuration (V2)
// 540 periods = ~6 months (at 8 hours per period)
// This is fixed and cannot be changed by users
const CLAIM_PERIODS_PER_TX = 540;

// Global state
let provider = null;
let signer = null;
let rewardEngineContract = null;
let currentNetwork = 'skale';
let connectedAddress = null;
let expectedWallet = null;

    // DOM elements
    const elements = {
        networkSelect: document.getElementById('networkSelect'),
        peerIdInput: document.getElementById('peerIdInput'),
        poolIdInput: document.getElementById('poolIdInput'),
        connectWallet: document.getElementById('connectWallet'),
        walletInfo: document.getElementById('walletInfo'),
        connectedAddress: document.getElementById('connectedAddress'),
        connectedNetwork: document.getElementById('connectedNetwork'),
        addFulaToken: document.getElementById('addFulaToken'),
        checkRewards: document.getElementById('checkRewards'),
        claimRewards: document.getElementById('claimRewards'),
        rewardsSection: document.getElementById('rewardsSection'),
        miningRewards: document.getElementById('miningRewards'),
        storageRewards: document.getElementById('storageRewards'),
        totalRewards: document.getElementById('totalRewards'),
        statusIndicator: document.getElementById('statusIndicator'),
        statusText: document.getElementById('statusText'),
        contractAddress: document.getElementById('contractAddress'),
        transactionStatus: document.getElementById('transactionStatus'),
        statusMessage: document.getElementById('statusMessage'),
        spinner: document.getElementById('spinner'),
        errorMessage: document.getElementById('errorMessage'),
        errorText: document.getElementById('errorText'),
        successMessage: document.getElementById('successMessage'),
        successText: document.getElementById('successText'),
        // Wallet warning elements
        walletWarning: document.getElementById('walletWarning'),
        walletWarningText: document.getElementById('walletWarningText'),
        // Monthly info elements
        monthlyInfo: document.getElementById('monthlyInfo'),
        infoStartOfMonth: document.getElementById('infoStartOfMonth'),
        infoNextMonthStart: document.getElementById('infoNextMonthStart'),
        infoClaimedThisMonth: document.getElementById('infoClaimedThisMonth'),
        infoClaimedPrevMonth: document.getElementById('infoClaimedPrevMonth'),
        infoTimeUntilNextMonth: document.getElementById('infoTimeUntilNextMonth'),
        // Claim status elements
        claimStatusSection: document.getElementById('claimStatusSection'),
        totalUnclaimedPeriods: document.getElementById('totalUnclaimedPeriods'),
        periodsPerClaim: document.getElementById('periodsPerClaim'),
        estimatedClaimsNeeded: document.getElementById('estimatedClaimsNeeded'),
        hasMoreToClaim: document.getElementById('hasMoreToClaim')
    };

/**
 * Initialize base58 decoder for PeerID conversion
 * Using a lightweight implementation compatible with browser
 */
async function initializeBase58() {
    // Simple base58 implementation
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const BASE = ALPHABET.length;

    function decode(s) {
        if (s.length === 0) return new Uint8Array(0);
        
        // Remove 'z' prefix if present (multibase format)
        if (s.startsWith('z')) {
            s = s.slice(1);
        }
        
        let decoded = 0n;
        let multi = 1n;
        
        for (let i = s.length - 1; i >= 0; i--) {
            const char = s[i];
            const index = ALPHABET.indexOf(char);
            if (index === -1) throw new Error(`Invalid character: ${char}`);
            decoded += BigInt(index) * multi;
            multi *= BigInt(BASE);
        }
        
        // Convert to bytes
        const bytes = [];
        while (decoded > 0n) {
            bytes.unshift(Number(decoded & 0xFFn));
            decoded >>= 8n;
        }
        
        // Count leading zeros in original string
        let leadingZeros = 0;
        for (let i = 0; i < s.length && s[i] === '1'; i++) {
            leadingZeros++;
        }
        
        return new Uint8Array([...Array(leadingZeros).fill(0), ...bytes]);
    }

    return { decode };
}

/**
 * Convert bytes32 back to PeerID for validation
 * @param {string} bytes32 - Hex string representation of bytes32
 * @returns {Promise<string>} - Original PeerID without 'z' prefix
 */
async function bytes32ToPeerId(bytes32) {
    try {
        const base58 = await initializeBase58();
        const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        
        // Convert hex to bytes
        const bytes = ethers.getBytes(bytes32);
        
        // Try CIDv1 format reconstruction
        const cidHeader = [0x00, 0x24, 0x08, 0x01, 0x12];
        const cidBytes = new Uint8Array([...cidHeader, ...bytes]);
        
        // Convert to base58
        let num = 0n;
        for (let i = 0; i < cidBytes.length; i++) {
            num = num * 256n + BigInt(cidBytes[i]);
        }
        
        let result = '';
        while (num > 0n) {
            result = ALPHABET[Number(num % 58n)] + result;
            num = num / 58n;
        }
        
        // Add leading '1's for leading zeros
        for (let i = 0; i < cidBytes.length && cidBytes[i] === 0; i++) {
            result = '1' + result;
        }
        
        return result;
    } catch (error) {
        // Try legacy multihash format
        const bytes = ethers.getBytes(bytes32);
        const multihashBytes = new Uint8Array([0x12, 0x20, ...bytes]);
        
        let num = 0n;
        for (let i = 0; i < multihashBytes.length; i++) {
            num = num * 256n + BigInt(multihashBytes[i]);
        }
        
        const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
        let result = '';
        while (num > 0n) {
            result = ALPHABET[Number(num % 58n)] + result;
            num = num / 58n;
        }
        
        // Add leading '1's for leading zeros
        for (let i = 0; i < multihashBytes.length && multihashBytes[i] === 0; i++) {
            result = '1' + result;
        }
        
        return result;
    }
}

/**
 * Convert PeerID to bytes32 format for smart contract usage
 * @param {string} peerId - The peer ID to convert
 * @returns {Promise<string>} - Hex string representation of bytes32
 */
async function peerIdToBytes32(peerId) {
    try {
        console.log('🔄 Converting PeerID to bytes32:', peerId);
        const base58 = await initializeBase58();

        // Normalize to multibase format (starts with z)
        if (!peerId.startsWith("z")) {
            peerId = `z${peerId}`;
        }

        const decoded = base58.decode(peerId);
        console.log('📊 Decoded bytes:', Array.from(decoded));

        let bytes32 = undefined;

        // CIDv1 (Ed25519 public key) format
        const CID_HEADER = [0x00, 0x24, 0x08, 0x01, 0x12];
        const isCIDv1 = CID_HEADER.every((v, i) => decoded[i] === v);

        if (isCIDv1 && decoded.length >= 37) {
            const pubkey = decoded.slice(decoded.length - 32);
            bytes32 = ethers.hexlify(pubkey);
            console.log('✅ CIDv1 format detected, extracted pubkey');
        }

        // Legacy multihash format
        if (decoded.length === 34 && decoded[0] === 0x12 && decoded[1] === 0x20) {
            const digest = decoded.slice(2);
            bytes32 = ethers.hexlify(digest);
            console.log('✅ Legacy multihash format detected');
        }

        if (!bytes32) {
            throw new Error(`Unsupported PeerID format or unexpected length: ${decoded.length}`);
        }

        // Reversible check
        const reconstructed = await bytes32ToPeerId(bytes32);
        if (reconstructed !== peerId.slice(1)) {
            console.warn('⚠️ Reversibility check failed, but proceeding...');
            console.log('Original (without z):', peerId.slice(1));
            console.log('Reconstructed:', reconstructed);
        }

        console.log('✅ PeerID converted successfully:', bytes32);
        return bytes32;
    } catch (err) {
        console.error("❌ Failed to convert PeerID to bytes32:", peerId, err);
        throw new Error(`Failed to convert PeerID: ${err.message}`);
    }
}

/**
 * Show error message to user
 * @param {string} message - Error message to display
 */
function showError(message) {
    elements.errorText.textContent = message;
    elements.errorMessage.style.display = 'block';
    elements.successMessage.style.display = 'none';
    
    // Auto-hide after 10 seconds
    setTimeout(() => {
        hideError();
    }, 10000);
}

/**
 * Hide error message
 */
function hideError() {
    elements.errorMessage.style.display = 'none';
}

/**
 * Show success message to user
 * @param {string} message - Success message to display
 */
function showSuccess(message) {
    elements.successText.textContent = message;
    elements.successMessage.style.display = 'block';
    elements.errorMessage.style.display = 'none';
    
    // Auto-hide after 8 seconds
    setTimeout(() => {
        hideSuccess();
    }, 8000);
}

/**
 * Hide success message
 */
function hideSuccess() {
    elements.successMessage.style.display = 'none';
}

/**
 * Show wallet mismatch warning (non-blocking)
 * @param {string} expected - Expected wallet address from URL
 * @param {string} connected - Actually connected wallet address
 */
function showWalletWarning(expected, connected) {
    elements.walletWarningText.textContent =
        `Warning: Expected wallet ${expected.slice(0, 6)}...${expected.slice(-4)} but you connected with ${connected.slice(0, 6)}...${connected.slice(-4)}. The rewards shown may not be accurate for this wallet.`;
    elements.walletWarning.style.display = 'flex';
}

/**
 * Hide wallet mismatch warning
 */
function hideWalletWarning() {
    elements.walletWarning.style.display = 'none';
}

/**
 * Decode contract error using the complete ABI
 * @param {Error} error - The contract error to decode
 * @returns {Object} - Decoded error information
 */
function decodeContractError(error) {
    try {
        // Create interface for error decoding
        const contractInterface = new ethers.Interface(REWARD_ENGINE_ABI);
        
        // Extract error data from the error object - check multiple locations
        let errorData = null;
        
        if (error.data) {
            errorData = error.data;
        } else if (error.reason && error.reason.startsWith('0x')) {
            errorData = error.reason;
        } else if (error.info?.error?.data) {
            // ethers v6 nested error format
            errorData = error.info.error.data;
        } else if (error.error?.data) {
            // Alternative nested format
            errorData = error.error.data;
        } else if (error.transaction && error.transaction.data) {
            // For call exceptions, try to extract from transaction data
            errorData = error.data || error.reason;
        }
        
        // Also check for revert reason in message
        if (!errorData && error.message) {
            const match = error.message.match(/data="(0x[a-fA-F0-9]+)"/);
            if (match) {
                errorData = match[1];
            }
        }
        
        if (errorData && errorData.startsWith('0x')) {
            try {
                const decoded = contractInterface.parseError(errorData);
                return {
                    name: decoded.name,
                    args: decoded.args,
                    signature: decoded.signature
                };
            } catch (parseError) {
                console.log('Could not parse error with interface:', parseError);
            }
        }
        
        // If we can't decode, return basic info
        return {
            name: 'Unknown',
            message: error.message || 'Unknown contract error',
            code: error.code,
            data: errorData
        };
    } catch (decodeError) {
        console.error('Error decoding contract error:', decodeError);
        return {
            name: 'DecodeError',
            message: error.message || 'Failed to decode contract error',
            originalError: error
        };
    }
}

/**
 * Get user-friendly error message for contract errors
 * @param {string} errorName - Name of the contract error
 * @param {Array} errorArgs - Arguments of the error
 * @returns {string} - User-friendly error message
 */
function getErrorMessage(errorName, errorArgs = []) {
    const errorMessages = {
        'InvalidPeerId': 'The Peer ID format is invalid. Please check your Peer ID.',
        'InvalidPoolId': 'The Pool ID is invalid. Please use a valid pool ID.',
        'NotPoolMember': 'You are not a member of this pool.',
        'NoRewardsToClaim': 'No rewards are available to claim at this time.',
        'InsufficientRewards': 'Insufficient rewards available.',
        'CircuitBreakerTripped': 'The contract is temporarily paused for security reasons.',
        'EnforcedPause': 'The contract is currently paused.',
        'InvalidAddress': 'Invalid wallet address.',
        'InsufficientBalance': 'Insufficient balance for this operation.',
        'CoolDownActive': 'Cooldown period is active. Please wait before trying again.',
        'AccessControlUnauthorizedAccount': 'You do not have permission to perform this action.',
        'ReentrancyGuardReentrantCall': 'Transaction failed due to reentrancy protection.',
        'TransferRestricted': 'Token transfer is restricted.',
        'InvalidAmount': 'Invalid amount specified.',
        'LowBalance': 'Wallet balance is too low for this operation.',
        'Failed': 'Transaction failed.',
        'FailedCall': 'Contract call failed.',
        // V2 errors
        'DeprecatedFunction': 'This function has been deprecated. Please update your application.',
        'NoDataToMigrate': 'No data available to migrate.',
        'MigrationAlreadyComplete': 'Migration has already been completed for this pool.',
        'MigrationNotComplete': 'Migration must be completed before claiming rewards. Please contact support.',
        'ExpectedPeriodChangeBlocked': 'Expected period cannot be changed after V2 data has been written.'
    };
    
    return errorMessages[errorName] || `Contract error: ${errorName}`;
}

/**
 * Show transaction status
 * @param {string} message - Status message
 * @param {boolean} showSpinner - Whether to show loading spinner
 */
function showTransactionStatus(message, showSpinner = false) {
    elements.statusMessage.textContent = message;
    elements.spinner.style.display = showSpinner ? 'block' : 'none';
    elements.transactionStatus.style.display = 'block';
}

/**
 * Hide transaction status
 */
function hideTransactionStatus() {
    elements.transactionStatus.style.display = 'none';
    elements.spinner.style.display = 'none';
}

/**
 * Update connection status indicator
 * @param {string} status - Status text
 * @param {string} indicator - Status indicator emoji
 */
function updateConnectionStatus(status, indicator) {
    elements.statusText.textContent = status;
    elements.statusIndicator.textContent = indicator;
}

/**
 * Update contract address display
 */
function updateContractAddress() {
    const network = NETWORKS[currentNetwork];
    elements.contractAddress.innerHTML = `
        <strong>Contract:</strong> 
        <a href="${network.blockExplorer}/address/${network.rewardEngineAddress}" target="_blank">
            ${network.rewardEngineAddress}
        </a>
    `;
}

/**
 * Validate PeerID format
 * @param {string} peerId - PeerID to validate
 * @returns {boolean} - Whether PeerID is valid
 */
function validatePeerID(peerId) {
    if (!peerId || peerId.trim().length === 0) {
        return false;
    }
    
    // Remove 'z' prefix if present
    const cleanPeerId = peerId.startsWith('z') ? peerId.slice(1) : peerId;
    
    // Basic length and character validation
    const base58Regex = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
    return cleanPeerId.length >= 44 && base58Regex.test(cleanPeerId);
}

/**
 * Request MetaMask to show the account picker using wallet_requestPermissions.
 * Returns the selected accounts array.
 */
async function requestAccountPicker() {
    await window.ethereum.request({
        method: 'wallet_requestPermissions',
        params: [{ eth_accounts: {} }]
    });
    // After permissions are granted, fetch the now-selected accounts
    return await window.ethereum.request({ method: 'eth_accounts' });
}

/**
 * Connect to MetaMask wallet
 * If an expectedWallet is set from URL params, it will automatically
 * prompt the account picker if the wrong account is initially connected.
 */
async function connectWallet() {
    try {
        console.log('🔗 Attempting to connect wallet...');

        if (!window.ethereum) {
            throw new Error('MetaMask not detected. Please install MetaMask browser extension.');
        }

        showTransactionStatus('Connecting to wallet...', true);

        // If an expected wallet is specified, use wallet_requestPermissions
        // to force the account picker so the user can choose the right one
        let accounts;
        if (expectedWallet) {
            console.log(`🎯 Expected wallet: ${expectedWallet}, opening account picker...`);
            showTransactionStatus('Please select the correct wallet in MetaMask...', true);
            accounts = await requestAccountPicker();
        } else {
            accounts = await window.ethereum.request({
                method: 'eth_requestAccounts'
            });
        }

        if (accounts.length === 0) {
            throw new Error('No accounts found. Please unlock your MetaMask wallet.');
        }

        // Create provider and signer
        provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();
        connectedAddress = accounts[0];

        // Get network info
        const network = await provider.getNetwork();
        console.log('🌐 Connected to network:', network);

        // Get proper network name from our config
        const networkConfig = Object.values(NETWORKS).find(n => Number(n.chainId) === Number(network.chainId));
        const networkName = networkConfig ? networkConfig.name : `Chain ID: ${network.chainId}`;

        // Update UI
        elements.connectedAddress.textContent = `${connectedAddress.slice(0, 6)}...${connectedAddress.slice(-4)}`;
        elements.connectedNetwork.textContent = networkName;
        elements.walletInfo.style.display = 'block';
        elements.connectWallet.textContent = 'Connected';
        elements.connectWallet.disabled = true;

        // Enable buttons
        elements.addFulaToken.disabled = false;
        elements.checkRewards.disabled = false;

        updateConnectionStatus('Wallet Connected', '🟢');
        hideTransactionStatus();
        showSuccess('Wallet connected successfully!');

        // Check if connected wallet matches the expected wallet from URL
        if (expectedWallet && connectedAddress.toLowerCase() !== expectedWallet.toLowerCase()) {
            showWalletWarning(expectedWallet, connectedAddress);
        } else {
            hideWalletWarning();
        }

        // Initialize contract
        await initializeContract();

        console.log('✅ Wallet connected successfully');
    } catch (error) {
        console.error('❌ Wallet connection failed:', error);
        hideTransactionStatus();
        showError(`Wallet connection failed: ${error.message}`);
        updateConnectionStatus('Connection Failed', '🔴');
    }
}

/**
 * Switch wallet by re-prompting the MetaMask account picker.
 * Called from the wallet mismatch warning banner.
 */
async function switchWallet() {
    try {
        if (!window.ethereum) {
            throw new Error('MetaMask not detected.');
        }

        showTransactionStatus('Please select the correct wallet in MetaMask...', true);

        const accounts = await requestAccountPicker();

        if (accounts.length === 0) {
            throw new Error('No accounts found.');
        }

        // Update provider, signer, and address
        provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();
        connectedAddress = accounts[0];

        // Update UI
        const network = await provider.getNetwork();
        const networkConfig = Object.values(NETWORKS).find(n => Number(n.chainId) === Number(network.chainId));
        const networkName = networkConfig ? networkConfig.name : `Chain ID: ${network.chainId}`;

        elements.connectedAddress.textContent = `${connectedAddress.slice(0, 6)}...${connectedAddress.slice(-4)}`;
        elements.connectedNetwork.textContent = networkName;

        hideTransactionStatus();

        // Re-check wallet match
        if (expectedWallet && connectedAddress.toLowerCase() !== expectedWallet.toLowerCase()) {
            showWalletWarning(expectedWallet, connectedAddress);
            showError('Still connected to the wrong wallet. Please try again.');
        } else {
            hideWalletWarning();
            showSuccess('Switched to the correct wallet!');
        }

        // Re-initialize contract with new signer
        await initializeContract();

    } catch (error) {
        console.error('❌ Wallet switch failed:', error);
        hideTransactionStatus();
        if (error.code === 4001) {
            showError('Wallet switch was cancelled.');
        } else {
            showError(`Failed to switch wallet: ${error.message}`);
        }
    }
}

/**
 * Initialize contract instance
 */
async function initializeContract() {
    try {
        const network = NETWORKS[currentNetwork];
        
        if (!provider || !signer) {
            throw new Error('Wallet not connected');
        }

        // Check if we're on the correct network
        const currentChainId = (await provider.getNetwork()).chainId;
        if (Number(currentChainId) !== network.chainId) {
            console.log(`🔄 Switching from chain ${currentChainId} to ${network.chainId}`);
            
            // Try to switch network
            try {
                await window.ethereum.request({
                    method: 'wallet_switchEthereumChain',
                    params: [{ chainId: `0x${network.chainId.toString(16)}` }],
                });
                
                // Wait a bit for the network switch to complete
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Recreate provider and signer after network switch
                provider = new ethers.BrowserProvider(window.ethereum);
                signer = await provider.getSigner();
                
            } catch (switchError) {
                console.log('Switch error code:', switchError.code);
                
                // If network doesn't exist, add it
                if (switchError.code === 4902) {
                    await window.ethereum.request({
                        method: 'wallet_addEthereumChain',
                        params: [{
                            chainId: `0x${network.chainId.toString(16)}`,
                            chainName: network.name,
                            rpcUrls: [network.rpcUrl],
                            blockExplorerUrls: [network.blockExplorer],
                            nativeCurrency: network.nativeCurrency
                        }],
                    });
                    
                    // Wait a bit for the network to be added and switched
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    
                    // Recreate provider and signer after network add
                    provider = new ethers.BrowserProvider(window.ethereum);
                    signer = await provider.getSigner();
                } else {
                    throw switchError;
                }
            }
        }

        // Verify we're on the correct network now
        const finalNetwork = await provider.getNetwork();
        if (Number(finalNetwork.chainId) !== network.chainId) {
            throw new Error(`Failed to switch to ${network.name}. Please manually switch networks in MetaMask.`);
        }

        // Create contract instance
        rewardEngineContract = new ethers.Contract(
            network.rewardEngineAddress,
            REWARD_ENGINE_ABI,
            signer
        );

        console.log('✅ Contract initialized:', network.rewardEngineAddress);
        updateContractAddress();
        
        // Update connected network display
        const networkConfig = Object.values(NETWORKS).find(n => Number(n.chainId) === Number(finalNetwork.chainId));
        const networkName = networkConfig ? networkConfig.name : `Chain ID: ${finalNetwork.chainId}`;
        elements.connectedNetwork.textContent = networkName;
        
    } catch (error) {
        console.error('❌ Contract initialization failed:', error);
        showError(`Contract initialization failed: ${error.message}`);
    }
}

/**
 * Add FULA token to the user's wallet using wallet_watchAsset
 */
async function addFulaToken() {
    try {
        if (!window.ethereum) {
            throw new Error('No wallet detected. Please install MetaMask or another Web3 wallet.');
        }

        if (!connectedAddress) {
            throw new Error('Please connect your wallet first');
        }

        const tokenConfig = CONFIG.FULA_TOKEN;
        
        console.log('🪙 Adding FULA token to wallet:', tokenConfig);
        showTransactionStatus('Adding FULA token to wallet...', false);

        const wasAdded = await window.ethereum.request({
            method: 'wallet_watchAsset',
            params: {
                type: 'ERC20',
                options: {
                    address: tokenConfig.address,
                    symbol: tokenConfig.symbol,
                    decimals: tokenConfig.decimals,
                    // image: '' // Optional: token logo URL
                },
            },
        });

        hideTransactionStatus();

        if (wasAdded) {
            showSuccess('FULA token added to your wallet successfully!');
            console.log('✅ FULA token added to wallet');
        } else {
            showError('Token was not added. You may have cancelled the request.');
            console.log('⚠️ User declined to add token');
        }
    } catch (error) {
        console.error('❌ Failed to add token:', error);
        hideTransactionStatus();
        
        if (error.code === 4001) {
            showError('Request was rejected by user');
        } else {
            showError(`Failed to add token: ${error.message}`);
        }
    }
}

/**
 * Check available rewards for the given peer ID
 */
async function checkRewards() {
    try {
        const peerId = elements.peerIdInput.value.trim();
        const poolId = parseInt(elements.poolIdInput.value) || 1;

        if (!validatePeerID(peerId)) {
            throw new Error('Please enter a valid Peer ID');
        }

        if (!connectedAddress) {
            throw new Error('Please connect your wallet first');
        }

        // Ensure we're on the correct network and contract is initialized
        await initializeContract();
        
        if (!rewardEngineContract) {
            throw new Error('Contract not initialized');
        }

        showTransactionStatus('Checking available rewards...', true);
        console.log('🔍 Checking rewards for:', { peerId, poolId, account: connectedAddress });

        // Convert PeerID to bytes32
        const peerIdBytes32 = await peerIdToBytes32(peerId);
        console.log('🔄 Converted PeerID:', peerIdBytes32);

        // Verify network before contract calls
        const currentChainId = (await provider.getNetwork()).chainId;
        const expectedChainId = NETWORKS[currentNetwork].chainId;
        
        if (Number(currentChainId) !== expectedChainId) {
            throw new Error(`Please switch to ${NETWORKS[currentNetwork].name} network in MetaMask`);
        }

        let miningRewards = 0n;
        let storageRewards = 0n;
        let rewardsError = null;

        try {
            // V2: getUnclaimedRewards returns mining + storage in one call.
            // Mining is computed from period-based accumulation; storage is the
            // accumulated balance credited by the pool operator via
            // submitStorageRewardsBatch on the upgraded RewardEngine.
            console.log('📊 Fetching unclaimed rewards (mining + storage)...');
            const result = await rewardEngineContract.getUnclaimedRewards(
                connectedAddress,
                peerIdBytes32,
                poolId
            );
            miningRewards = result.unclaimedMining ?? result[0];
            storageRewards = result.unclaimedStorage ?? result[1];
            console.log('✅ Unclaimed rewards:', {
                mining: miningRewards.toString(),
                storage: storageRewards.toString()
            });
        } catch (err) {
            console.warn('⚠️ getUnclaimedRewards check failed:', err);

            const decodedError = decodeContractError(err);
            console.log('🔍 Decoded error:', decodedError);

            // Handle critical errors that should stop execution
            if (decodedError.name === 'InvalidPeerId') {
                throw new Error('Invalid Peer ID format');
            } else if (decodedError.name === 'InvalidPoolId') {
                throw new Error('Invalid Pool ID');
            } else if (decodedError.name === 'CircuitBreakerTripped') {
                throw new Error('Contract is temporarily paused for security reasons');
            } else if (decodedError.name === 'EnforcedPause') {
                throw new Error('Contract is currently paused');
            }

            // Store error for UI display
            rewardsError = decodedError;
        }

        // Calculate total
        const totalRewards = miningRewards + storageRewards;

        // Format rewards for display (assuming 18 decimals)
        const formatReward = (amount) => {
            const formatted = ethers.formatEther(amount);
            return parseFloat(formatted).toFixed(6);
        };

        // Update UI with rewards and error information
        const rewardsErrorText = rewardsError
            ? `Error: ${getErrorMessage(rewardsError.name)}`
            : null;
        elements.miningRewards.textContent = rewardsErrorText ?? `${formatReward(miningRewards)} tokens`;
        elements.storageRewards.textContent = rewardsErrorText ?? `${formatReward(storageRewards)} tokens`;
        elements.totalRewards.textContent = `${formatReward(totalRewards)} tokens`;
        elements.rewardsSection.style.display = 'block';

        // Enable claim button if there are rewards
        elements.claimRewards.disabled = totalRewards === 0n;

        // Fetch and display claim status (periods info)
        try {
            console.log('📊 Fetching claim status (V2)...');
            const [totalUnclaimedPeriods, defaultPeriodsPerClaim, maxPeriodsPerClaim, estimatedClaimsNeeded, hasMoreToClaim] = 
                await rewardEngineContract.getClaimStatusV2(connectedAddress, peerIdBytes32, poolId);
            
            console.log('✅ Claim status:', {
                totalUnclaimedPeriods: totalUnclaimedPeriods.toString(),
                defaultPeriodsPerClaim: defaultPeriodsPerClaim.toString(),
                estimatedClaimsNeeded: estimatedClaimsNeeded.toString(),
                hasMoreToClaim
            });

            // Update claim status UI if elements exist
            if (elements.claimStatusSection) {
                if (elements.totalUnclaimedPeriods) {
                    elements.totalUnclaimedPeriods.textContent = totalUnclaimedPeriods.toString();
                }
                if (elements.periodsPerClaim) {
                    elements.periodsPerClaim.textContent = `${CLAIM_PERIODS_PER_TX} (~6 months)`;
                }
                if (elements.estimatedClaimsNeeded) {
                    elements.estimatedClaimsNeeded.textContent = estimatedClaimsNeeded.toString();
                }
                if (elements.hasMoreToClaim) {
                    elements.hasMoreToClaim.textContent = hasMoreToClaim ? 'Yes - Multiple claims needed' : 'No - Single claim sufficient';
                    elements.hasMoreToClaim.style.color = hasMoreToClaim ? '#f39c12' : '#27ae60';
                }
                elements.claimStatusSection.style.display = 'block';
            }

            // Update claim button text to indicate batched claiming
            if (hasMoreToClaim && totalRewards > 0n) {
                elements.claimRewards.textContent = `Claim Rewards (~6 months worth)`;
            } else {
                elements.claimRewards.textContent = 'Claim Rewards';
            }

        } catch (claimStatusErr) {
            console.warn('⚠️ Could not fetch claim status (non-fatal):', claimStatusErr);
            // Hide claim status section on error
            if (elements.claimStatusSection) {
                elements.claimStatusSection.style.display = 'none';
            }
        }

        // Show monthly details if no rewards (e.g., due to monthly cap)
        try {
            if (totalRewards === 0n) {
                // Fetch month length and latest block timestamp
                const [secondsPerMonthBN, latestBlock] = await Promise.all([
                    rewardEngineContract.SECONDS_PER_MONTH(),
                    provider.getBlock('latest')
                ]);

                const now = BigInt(latestBlock.timestamp);
                const SPM = BigInt(secondsPerMonthBN);
                const currentMonth = now / SPM;
                const previousMonth = currentMonth - 1n;
                const currentMonthStart = currentMonth * SPM;
                const nextMonthStart = (currentMonth + 1n) * SPM;
                const timeUntilNextMonth = nextMonthStart - now;

                // Query claimed amounts for peer
                const [claimedThisMonth, claimedPrevMonth] = await Promise.all([
                    rewardEngineContract.monthlyRewardsClaimed(peerIdBytes32, poolId, currentMonth),
                    rewardEngineContract.monthlyRewardsClaimed(peerIdBytes32, poolId, previousMonth)
                ]);

                // Format helpers
                const toDateTime = (ts) => {
                    const d = new Date(Number(ts) * 1000);
                    return d.toLocaleString();
                };
                const toDays = (secsBig) => {
                    const secs = Number(secsBig);
                    const days = secs / (60 * 60 * 24);
                    return `${days.toFixed(1)} days`;
                };

                elements.infoStartOfMonth.textContent = toDateTime(currentMonthStart);
                elements.infoNextMonthStart.textContent = toDateTime(nextMonthStart);
                elements.infoClaimedThisMonth.textContent = `${formatReward(claimedThisMonth)} tokens`;
                elements.infoClaimedPrevMonth.textContent = `${formatReward(claimedPrevMonth)} tokens`;
                elements.infoTimeUntilNextMonth.textContent = toDays(timeUntilNextMonth);

                elements.monthlyInfo.style.display = 'block';
            } else {
                // Hide monthly info when rewards exist
                if (elements.monthlyInfo) {
                    elements.monthlyInfo.style.display = 'none';
                }
            }
        } catch (infoErr) {
            console.warn('Monthly info fetch failed (non-fatal):', infoErr);
            // Do not block main flow; hide the section on error
            if (elements.monthlyInfo) {
                elements.monthlyInfo.style.display = 'none';
            }
        }

        hideTransactionStatus();
        
        // Show appropriate message based on results
        if (totalRewards > 0n) {
            showSuccess(`Found ${formatReward(totalRewards)} tokens available for claiming!`);
        } else if (rewardsError) {
            showError(`Could not load rewards: ${getErrorMessage(rewardsError.name)}.`);
        } else {
            showSuccess('Rewards checked successfully. No rewards available for claiming at this time.');
        }

        console.log('✅ Rewards checked successfully:', {
            mining: formatReward(miningRewards),
            storage: formatReward(storageRewards),
            total: formatReward(totalRewards)
        });

    } catch (error) {
        console.error('❌ Check rewards failed:', error);
        hideTransactionStatus();
        
        // Try to decode contract error first
        const decodedError = decodeContractError(error);
        let errorMessage;
        
        if (decodedError.name && decodedError.name !== 'Unknown') {
            errorMessage = getErrorMessage(decodedError.name, decodedError.args);
        } else if (error.message.includes('could not decode result data')) {
            errorMessage = 'Contract call failed. Please ensure you are on the correct network and the contract address is valid.';
        } else if (error.message.includes('network')) {
            errorMessage = error.message;
        } else {
            errorMessage = `Failed to check rewards: ${error.message}`;
        }
        
        showError(errorMessage);
    }
}

/**
 * Claim available rewards
 * Uses claimRewardsWithLimitV2 with 540 periods (~6 months) per transaction
 * This is a fixed value and cannot be changed by users to ensure gas efficiency
 */
async function claimRewards() {
    try {
        const peerId = elements.peerIdInput.value.trim();
        const poolId = parseInt(elements.poolIdInput.value) || 1;

        if (!validatePeerID(peerId)) {
            throw new Error('Please enter a valid Peer ID');
        }

        if (!connectedAddress || !rewardEngineContract) {
            throw new Error('Please connect your wallet and check rewards first');
        }

        showTransactionStatus('Preparing claim transaction...', true);
        console.log('🚀 Starting claim process:', { peerId, poolId, periodsPerClaim: CLAIM_PERIODS_PER_TX });

        // Convert PeerID to bytes32
        const peerIdBytes32 = await peerIdToBytes32(peerId);
        console.log('🔄 Converted PeerID for claim:', peerIdBytes32);

        // Pre-flight check: simulate the transaction to catch errors before MetaMask
        showTransactionStatus('Verifying claim eligibility...', true);
        console.log(`📋 Pre-flight check for ${CLAIM_PERIODS_PER_TX} periods (~6 months worth)`);
        
        try {
            await rewardEngineContract.claimRewardsWithLimitV2.staticCall(
                peerIdBytes32,
                poolId,
                CLAIM_PERIODS_PER_TX
            );
            console.log('✅ Pre-flight check passed');
        } catch (simulationError) {
            console.error('❌ Pre-flight simulation failed:', simulationError);
            const decodedError = decodeContractError(simulationError);
            if (decodedError.name && decodedError.name !== 'Unknown') {
                throw new Error(getErrorMessage(decodedError.name, decodedError.args));
            }
            throw new Error(`Claim would fail: ${simulationError.message}`);
        }
        
        // Prepare transaction using claimRewardsWithLimitV2 with fixed 540 periods (~6 months)
        // This ensures gas costs are bounded and predictable
        showTransactionStatus('Please confirm transaction in your wallet...', true);
        console.log(`⛽ Using gas limit: ${GAS_LIMITS[currentNetwork].claimRewards} for network: ${currentNetwork}`);
        
        // Build transaction options - only set gas limit, let wallet handle gas price
        // Base L2 has very low gas prices that the wallet will determine correctly
        const txOptions = {
            gasLimit: GAS_LIMITS[currentNetwork].claimRewards
        };
        
        const tx = await rewardEngineContract.claimRewardsWithLimitV2(
            peerIdBytes32, 
            poolId, 
            CLAIM_PERIODS_PER_TX,  // Fixed at 540 periods (~6 months)
            txOptions
        );

        showTransactionStatus(`Transaction submitted: ${tx.hash}`, true);
        console.log('📡 Transaction submitted:', tx.hash);

        // Wait for confirmation
        showTransactionStatus('Waiting for transaction confirmation...', true);
        const receipt = await tx.wait();

        console.log('✅ Transaction confirmed:', {
            hash: receipt.hash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed?.toString()
        });

        hideTransactionStatus();
        
        // Check if there are more periods to claim
        try {
            const [totalUnclaimedPeriods, , , , hasMoreToClaim] = 
                await rewardEngineContract.getClaimStatusV2(connectedAddress, peerIdBytes32, poolId);
            
            if (hasMoreToClaim && totalUnclaimedPeriods > 0n) {
                showSuccess(`Rewards claimed successfully! You have ${totalUnclaimedPeriods} more periods to claim. Click "Check Rewards" and claim again.`);
            } else {
                showSuccess(`Rewards claimed successfully! Transaction: ${receipt.hash}`);
            }
        } catch (statusErr) {
            // Fallback if status check fails
            showSuccess(`Rewards claimed successfully! Transaction: ${receipt.hash}`);
        }

        // Refresh rewards display
        setTimeout(() => {
            checkRewards();
        }, 2000);

    } catch (error) {
        console.error('❌ Claim rewards failed:', error);
        hideTransactionStatus();
        
        // Try to decode contract error first
        const decodedError = decodeContractError(error);
        let errorMessage;
        
        // Handle specific error types
        if (error.code === 'ACTION_REJECTED') {
            errorMessage = 'Transaction was rejected by user';
        } else if (error.code === 'INSUFFICIENT_FUNDS') {
            errorMessage = 'Insufficient funds for gas fees';
        } else if (decodedError.name && decodedError.name !== 'Unknown') {
            errorMessage = getErrorMessage(decodedError.name, decodedError.args);
        } else {
            errorMessage = `Failed to claim rewards: ${error.message}`;
        }
        
        showError(errorMessage);
    }
}

/**
 * Handle network selection change
 */
function handleNetworkChange() {
    currentNetwork = elements.networkSelect.value;
    console.log('🌐 Network changed to:', currentNetwork);
    
    // Reset contract
    rewardEngineContract = null;
    
    // Update contract address display
    updateContractAddress();
    
    // Reinitialize contract if wallet is connected
    if (provider && signer) {
        initializeContract();
    }
    
    // Hide rewards section
    elements.rewardsSection.style.display = 'none';
    
    // Hide monthly info
    if (elements.monthlyInfo) {
        elements.monthlyInfo.style.display = 'none';
    }
    
    // Hide claim status section
    if (elements.claimStatusSection) {
        elements.claimStatusSection.style.display = 'none';
    }
    
    // Disable claim button and reset text
    elements.claimRewards.disabled = true;
    elements.claimRewards.textContent = 'Claim Rewards';
}

/**
 * Handle input validation
 */
function handleInputChange() {
    const peerId = elements.peerIdInput.value.trim();
    const isValidPeer = validatePeerID(peerId);
    const isConnected = !!connectedAddress;
    
    // Enable check button only if peer ID is valid and wallet is connected
    elements.checkRewards.disabled = !isValidPeer || !isConnected;
    
    // Hide rewards if peer ID changes
    if (elements.rewardsSection.style.display === 'block') {
        elements.rewardsSection.style.display = 'none';
        elements.claimRewards.disabled = true;
    }
    
    // Hide monthly info when inputs change
    if (elements.monthlyInfo) {
        elements.monthlyInfo.style.display = 'none';
    }
    
    // Hide claim status when inputs change
    if (elements.claimStatusSection) {
        elements.claimStatusSection.style.display = 'none';
    }
    
    // Reset claim button text
    elements.claimRewards.textContent = 'Claim Rewards';
}

/**
 * Parse URL parameters and apply them to form fields
 * Supports: ?network=skale|base&peerId=xxxxx
 */
function applyUrlParameters() {
    const urlParams = new URLSearchParams(window.location.search);
    
    // Check for network parameter
    const networkParam = urlParams.get('network');
    if (networkParam) {
        const normalizedNetwork = networkParam.toLowerCase();
        if (normalizedNetwork === 'skale' || normalizedNetwork === 'base') {
            elements.networkSelect.value = normalizedNetwork;
            currentNetwork = normalizedNetwork;
            console.log(`🔗 Network set from URL: ${normalizedNetwork}`);
        } else {
            console.warn(`⚠️ Invalid network in URL: ${networkParam}. Use 'skale' or 'base'.`);
        }
    }
    
    // Check for peerId parameter
    const peerIdParam = urlParams.get('peerId');
    if (peerIdParam) {
        elements.peerIdInput.value = peerIdParam;
        console.log(`🔗 PeerID set from URL: ${peerIdParam}`);
    }
    
    // Check for wallet parameter (expected wallet address)
    const walletParam = urlParams.get('wallet');
    if (walletParam) {
        expectedWallet = walletParam;
        console.log(`🔗 Expected wallet set from URL: ${walletParam}`);
    }

    // Check for poolId parameter (optional)
    const poolIdParam = urlParams.get('poolId');
    if (poolIdParam && !isNaN(parseInt(poolIdParam))) {
        elements.poolIdInput.value = parseInt(poolIdParam);
        console.log(`🔗 PoolID set from URL: ${poolIdParam}`);
    }
}

/**
 * Initialize the application
 */
function initializeApp() {
    console.log('🚀 Initializing Reward Engine Portal...');
    
    // Apply URL parameters first (before event listeners to avoid triggering changes)
    applyUrlParameters();
    
    // Set up event listeners
    elements.connectWallet.addEventListener('click', connectWallet);
    elements.addFulaToken.addEventListener('click', addFulaToken);
    elements.checkRewards.addEventListener('click', checkRewards);
    elements.claimRewards.addEventListener('click', claimRewards);
    elements.networkSelect.addEventListener('change', handleNetworkChange);
    elements.peerIdInput.addEventListener('input', handleInputChange);
    elements.poolIdInput.addEventListener('input', handleInputChange);
    
    // Initialize contract address display
    updateContractAddress();
    
    // Display version
    const versionInfo = document.getElementById('versionInfo');
    if (versionInfo) {
        versionInfo.textContent = `v${VERSION}`;
    }
    
    // Check if wallet is already connected
    if (window.ethereum && window.ethereum.selectedAddress) {
        console.log('👛 Wallet already connected, attempting to reconnect...');
        connectWallet();
    }
    
    console.log('✅ Application initialized successfully');
}

// Global functions for HTML onclick handlers
window.hideError = hideError;
window.hideSuccess = hideSuccess;
window.hideWalletWarning = hideWalletWarning;
window.switchWallet = switchWallet;

// Initialize when DOM is loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
