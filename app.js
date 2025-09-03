// Import ethers v6 from CDN
import { ethers } from "https://cdnjs.cloudflare.com/ajax/libs/ethers/6.7.0/ethers.min.js";
// Import configuration and ABI
import { CONFIG } from "./config.js";
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

// Global state
let provider = null;
let signer = null;
let rewardEngineContract = null;
let currentNetwork = 'skale';
let connectedAddress = null;

// DOM elements
const elements = {
    networkSelect: document.getElementById('networkSelect'),
    peerIdInput: document.getElementById('peerIdInput'),
    poolIdInput: document.getElementById('poolIdInput'),
    connectWallet: document.getElementById('connectWallet'),
    walletInfo: document.getElementById('walletInfo'),
    connectedAddress: document.getElementById('connectedAddress'),
    connectedNetwork: document.getElementById('connectedNetwork'),
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
    successText: document.getElementById('successText')
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
 * Decode contract error using the complete ABI
 * @param {Error} error - The contract error to decode
 * @returns {Object} - Decoded error information
 */
function decodeContractError(error) {
    try {
        // Create interface for error decoding
        const contractInterface = new ethers.Interface(REWARD_ENGINE_ABI);
        
        // Extract error data from the error object
        let errorData = null;
        
        if (error.data) {
            errorData = error.data;
        } else if (error.reason && error.reason.startsWith('0x')) {
            errorData = error.reason;
        } else if (error.transaction && error.transaction.data) {
            // For call exceptions, try to extract from transaction data
            errorData = error.data || error.reason;
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
        'FailedCall': 'Contract call failed.'
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
 * Connect to MetaMask wallet
 */
async function connectWallet() {
    try {
        console.log('🔗 Attempting to connect wallet...');
        
        if (!window.ethereum) {
            throw new Error('MetaMask not detected. Please install MetaMask browser extension.');
        }

        showTransactionStatus('Connecting to wallet...', true);

        // Request account access
        const accounts = await window.ethereum.request({
            method: 'eth_requestAccounts'
        });

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
        elements.checkRewards.disabled = false;
        
        updateConnectionStatus('Wallet Connected', '🟢');
        hideTransactionStatus();
        showSuccess('Wallet connected successfully!');

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
        let miningError = null;
        let storageError = null;

        try {
            // Check mining rewards
            console.log('📊 Checking mining rewards...');
            miningRewards = await rewardEngineContract.calculateEligibleMiningRewards(
                connectedAddress,
                peerIdBytes32,
                poolId
            );
            console.log('✅ Mining rewards:', miningRewards.toString());
        } catch (miningErr) {
            console.warn('⚠️ Mining rewards check failed:', miningErr);
            
            // Try to decode the custom error
            const decodedError = decodeContractError(miningErr);
            console.log('🔍 Decoded mining error:', decodedError);
            
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
            miningError = decodedError;
        }

        try {
            // Check storage rewards
            console.log('📊 Checking storage rewards...');
            storageRewards = await rewardEngineContract.calculateEligibleStorageRewards(
                connectedAddress,
                peerIdBytes32,
                poolId
            );
            console.log('✅ Storage rewards:', storageRewards.toString());
        } catch (storageErr) {
            console.warn('⚠️ Storage rewards check failed:', storageErr);
            
            // Try to decode the custom error
            const decodedError = decodeContractError(storageErr);
            console.log('🔍 Decoded storage error:', decodedError);
            
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
            storageError = decodedError;
        }

        // Calculate total
        const totalRewards = miningRewards + storageRewards;

        // Format rewards for display (assuming 18 decimals)
        const formatReward = (amount) => {
            const formatted = ethers.formatEther(amount);
            return parseFloat(formatted).toFixed(6);
        };

        // Update UI with rewards and error information
        elements.miningRewards.textContent = miningError 
            ? `Error: ${getErrorMessage(miningError.name)}` 
            : `${formatReward(miningRewards)} tokens`;
            
        elements.storageRewards.textContent = storageError 
            ? `Error: ${getErrorMessage(storageError.name)}` 
            : `${formatReward(storageRewards)} tokens`;
            
        elements.totalRewards.textContent = `${formatReward(totalRewards)} tokens`;
        elements.rewardsSection.style.display = 'block';

        // Enable claim button if there are rewards
        elements.claimRewards.disabled = totalRewards === 0n;

        hideTransactionStatus();
        
        // Show appropriate message based on results
        if (totalRewards > 0n) {
            showSuccess(`Found ${formatReward(totalRewards)} tokens available for claiming!`);
        } else if (miningError || storageError) {
            // Show warning about specific errors
            let warningMessage = 'Rewards checked successfully. ';
            if (miningError && storageError) {
                warningMessage += `Mining: ${getErrorMessage(miningError.name)}. Storage: ${getErrorMessage(storageError.name)}.`;
            } else if (miningError) {
                warningMessage += `Mining rewards error: ${getErrorMessage(miningError.name)}.`;
            } else if (storageError) {
                warningMessage += `Storage rewards error: ${getErrorMessage(storageError.name)}.`;
            }
            showError(warningMessage);
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
        console.log('🚀 Starting claim process:', { peerId, poolId });

        // Convert PeerID to bytes32
        const peerIdBytes32 = await peerIdToBytes32(peerId);
        console.log('🔄 Converted PeerID for claim:', peerIdBytes32);

        // Prepare transaction
        showTransactionStatus('Please confirm transaction in your wallet...', true);
        
        const tx = await rewardEngineContract.claimRewards(peerIdBytes32, poolId, {
            gasLimit: GAS_LIMITS.claimRewards
        });

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
        showSuccess(`Rewards claimed successfully! Transaction: ${receipt.hash}`);

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
    elements.claimRewards.disabled = true;
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
}

/**
 * Initialize the application
 */
function initializeApp() {
    console.log('🚀 Initializing Reward Engine Portal...');
    
    // Set up event listeners
    elements.connectWallet.addEventListener('click', connectWallet);
    elements.checkRewards.addEventListener('click', checkRewards);
    elements.claimRewards.addEventListener('click', claimRewards);
    elements.networkSelect.addEventListener('change', handleNetworkChange);
    elements.peerIdInput.addEventListener('input', handleInputChange);
    elements.poolIdInput.addEventListener('input', handleInputChange);
    
    // Initialize contract address display
    updateContractAddress();
    
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

// Initialize when DOM is loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}
