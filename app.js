// Import ethers v6 from CDN
import { ethers } from "https://cdnjs.cloudflare.com/ajax/libs/ethers/6.7.0/ethers.min.js";
// Reown AppKit (formerly Web3Modal) — wallet connection layer.
// Replaces direct window.ethereum / wallet_requestPermissions usage; supports
// MetaMask + injected wallets on desktop AND any WalletConnect-compatible mobile
// wallet via QR / deep-link, sidestepping the CAIP-25 endowment errors users hit
// against newer MetaMask builds. Versions are pinned to avoid breakage from
// silent CDN updates; appkit and appkit-adapter-ethers MUST be on matching majors.
import { createAppKit } from "https://esm.sh/@reown/appkit@1.8.20";
import { EthersAdapter } from "https://esm.sh/@reown/appkit-adapter-ethers@1.8.20";
import { defineChain } from "https://esm.sh/@reown/appkit@1.8.20/networks";
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

// Reown AppKit instance + EIP-1193 provider supplied by whichever wallet the
// user picked in the modal (MetaMask, Coinbase, mobile via WalletConnect, etc.).
// `lastFinalizedAddress` tracks which address we've already wired up an ethers
// signer + contract for, so the subscriber-driven connect flow is idempotent
// even when subscribeAccount fires repeatedly with the same payload.
let appKit = null;
let eip1193Provider = null;
let lastFinalizedAddress = null;

// AppKit chain objects (one per supported network), built from CONFIG.NETWORKS
// inside initializeAppKit(). Kept separate from the legacy NETWORKS map below
// because AppKit expects a different shape (defineChain output).
const APPKIT_CHAINS = { skale: null, base: null };

// Catch-up state: populated by checkRewards() when getUnclaimedRewards
// returns 0 BUT the user's effective claim start is older than the contract's
// view window (MAX_VIEW_PERIODS_V2 * expectedPeriod). In that case, the
// contract's claim path advances `lastClaimedRewards` even when no rewards
// are paid (see RewardEngine._claimRewardsInternalV2 "Nothing to actually pay
// this call: advance mining timestamp through empty periods"), so a series of
// 0-reward "advance" claims is needed before real rewards become visible.
//
// Shape when active:
//   { daysBehind, estimatedCatchUpClaims, hasRecentActivity }
// null when not in catch-up mode.
let catchUpState = null;

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
        hasMoreToClaim: document.getElementById('hasMoreToClaim'),
        // Catch-up banner elements
        catchUpBanner: document.getElementById('catchUpBanner'),
        catchUpBody: document.getElementById('catchUpBody'),
        // Manual-add fallback for FULA token
        showManualAdd: document.getElementById('showManualAdd'),
        manualAddPanel: document.getElementById('manualAddPanel'),
        manualAddAddress: document.getElementById('manualAddAddress'),
        manualAddSymbol: document.getElementById('manualAddSymbol'),
        manualAddDecimals: document.getElementById('manualAddDecimals'),
        manualAddNetwork: document.getElementById('manualAddNetwork')
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
 * Show the catch-up banner with a message tailored to the user's state.
 * @param {{daysBehind:number, estimatedCatchUpClaims:number, hasRecentActivity:boolean}} state
 */
function showCatchUpBanner(state) {
    if (!elements.catchUpBanner || !elements.catchUpBody) return;

    const claimsWord = state.estimatedCatchUpClaims === 1 ? 'transaction' : 'transactions';
    const activityNote = state.hasRecentActivity
        ? 'Your peer has been online recently, so once the window catches up you should see rewards.'
        : '<strong>Your peer does not appear to have been online recently.</strong> '
          + 'Catch-up transactions will advance your claim window but will not pay rewards '
          + 'unless your node has been submitting online status. Ensure your node is running first.';

    elements.catchUpBody.innerHTML =
        `Your last-claimed timestamp is <strong>${Math.round(state.daysBehind)} days</strong> behind. `
        + `Because each claim transaction can advance at most ~6 months, you need approximately `
        + `<strong>${state.estimatedCatchUpClaims} ${claimsWord}</strong> to catch up. `
        + `The first call(s) will pay <strong>0 tokens</strong> — they only advance your claim `
        + `window through empty periods. Once the window reaches periods where your peer was online, `
        + `subsequent claims pay rewards normally.<br><br>${activityNote}`;
    elements.catchUpBanner.style.display = 'block';
}

/**
 * Hide the catch-up banner.
 */
function hideCatchUpBanner() {
    if (elements.catchUpBanner) {
        elements.catchUpBanner.style.display = 'none';
    }
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
 * Build the AppKit chain object for one of our networks from CONFIG.NETWORKS.
 * Kept here so CONFIG.NETWORKS remains the single source of truth.
 */
function buildAppKitChain(key, explorerName) {
    const n = CONFIG.NETWORKS[key];
    return defineChain({
        id: n.chainId,
        caipNetworkId: `eip155:${n.chainId}`,
        chainNamespace: 'eip155',
        name: n.name,
        nativeCurrency: n.nativeCurrency,
        rpcUrls: { default: { http: [n.rpcUrl] } },
        blockExplorers: { default: { name: explorerName, url: n.blockExplorer } },
    });
}

/**
 * One-time AppKit initialization. Idempotent: safe to call multiple times,
 * only the first call constructs the modal. Subscribers are wired here so they
 * fire on the persisted-session auto-reconnect path (page reload after a prior
 * connect) without any further user action.
 */
async function initializeAppKit() {
    if (appKit) return;

    APPKIT_CHAINS.skale = buildAppKitChain('skale', 'SKALE Explorer');
    APPKIT_CHAINS.base = buildAppKitChain('base', 'Basescan');

    appKit = createAppKit({
        adapters: [new EthersAdapter()],
        networks: [APPKIT_CHAINS.skale, APPKIT_CHAINS.base],
        defaultNetwork: APPKIT_CHAINS[currentNetwork],
        projectId: CONFIG.REOWN_PROJECT_ID,
        metadata: CONFIG.APP_METADATA,
        // Keep the modal focused on actual wallets — no email/social login,
        // no telemetry pings to Reown's analytics endpoint.
        features: { analytics: false, email: false, socials: false }
    });

    setupAppKitSubscribers();
}

/**
 * Wire AppKit's reactive streams up to our connect/disconnect lifecycle.
 *
 * `subscribeProviders` and `subscribeAccount` fire independently and in
 * undefined order — on auto-reconnect after page refresh, the account state
 * can land before the EIP-1193 provider has been hydrated, or vice-versa.
 * `maybeFinalizeConnect()` gates on BOTH signals being present before wiring
 * up an ethers signer + contract, so the two orderings produce the same end
 * state.
 */
function setupAppKitSubscribers() {
    appKit.subscribeProviders((state) => {
        eip1193Provider = state?.['eip155'] ?? null;
        maybeFinalizeConnect();
    });

    appKit.subscribeAccount((state) => {
        const wasConnected = !!lastFinalizedAddress;
        const isConnectedNow = !!(state?.isConnected && state?.address);

        if (isConnectedNow) {
            maybeFinalizeConnect(state.address);
        } else if (wasConnected) {
            onWalletDisconnected();
        }
    });

    appKit.subscribeNetwork((state) => {
        const newChainId = state?.chainId ? Number(state.chainId) : null;
        onNetworkChanged(newChainId);
    });
}

/**
 * Finalize the connect flow once we have BOTH an EIP-1193 provider AND a
 * connected address. Idempotent: skips work if we've already finalized for
 * this address. Called from both subscribeProviders and subscribeAccount.
 */
function maybeFinalizeConnect(addressFromAccountState) {
    const address = addressFromAccountState ?? appKit?.getAddress();
    if (!eip1193Provider || !address) return;
    if (lastFinalizedAddress?.toLowerCase() === address.toLowerCase()) return;

    lastFinalizedAddress = address;
    onWalletConnected(address).catch((err) => {
        console.error('Wallet finalize failed:', err);
        showError(`Wallet connection failed: ${err.message}`);
        updateConnectionStatus('Connection Failed', '🔴');
    });
}

/**
 * Build the ethers provider + signer from the AppKit-supplied EIP-1193
 * provider and bring the rest of the UI in sync. Mirrors what the old
 * connectWallet() did after eth_requestAccounts succeeded.
 */
async function onWalletConnected(address) {
    showTransactionStatus('Finalizing wallet connection...', true);

    // If this is an account-switch within an already-connected session (user
    // changed accounts in their wallet UI), the old account's rewards / catch-up
    // UI is now stale. Hide it before re-wiring; the user will need to click
    // "Check Rewards" again for the new account.
    const isAccountSwitch = connectedAddress && connectedAddress.toLowerCase() !== address.toLowerCase();
    if (isAccountSwitch) {
        elements.rewardsSection.style.display = 'none';
        if (elements.claimStatusSection) elements.claimStatusSection.style.display = 'none';
        if (elements.monthlyInfo) elements.monthlyInfo.style.display = 'none';
        catchUpState = null;
        hideCatchUpBanner();
        elements.claimRewards.disabled = true;
        elements.claimRewards.textContent = 'Claim Rewards';
    }

    provider = new ethers.BrowserProvider(eip1193Provider);
    signer = await provider.getSigner();
    connectedAddress = address;

    // Sync the network dropdown to whatever chain the wallet actually landed on.
    // If the wallet is on a chain we recognize, prefer that over the dropdown's
    // prior value (wallet is the source of truth on connect).
    const walletChainId = Number(appKit.getChainId() ?? 0);
    const walletNetworkKey = Object.keys(NETWORKS).find(k => NETWORKS[k].chainId === walletChainId);
    if (walletNetworkKey && walletNetworkKey !== currentNetwork) {
        currentNetwork = walletNetworkKey;
        elements.networkSelect.value = walletNetworkKey;
        updateContractAddress();
    }

    const networkConfig = walletNetworkKey ? NETWORKS[walletNetworkKey] : null;
    const networkName = networkConfig ? networkConfig.name : `Chain ID: ${walletChainId}`;

    elements.connectedAddress.textContent = `${connectedAddress.slice(0, 6)}...${connectedAddress.slice(-4)}`;
    elements.connectedNetwork.textContent = networkName;
    elements.walletInfo.style.display = 'block';
    elements.connectWallet.textContent = 'Connected';
    elements.connectWallet.disabled = true;

    elements.addFulaToken.disabled = false;
    // Only enable check-rewards if the peer ID input is also valid.
    elements.checkRewards.disabled = !validatePeerID(elements.peerIdInput.value.trim());

    updateConnectionStatus('Wallet Connected', '🟢');

    // initializeContract() handles switching the wallet's chain if the dropdown
    // selection disagrees with the wallet's current chain.
    await initializeContract();

    // Expected-wallet (?wallet=) URL parameter check — preserved from old flow.
    if (expectedWallet && connectedAddress.toLowerCase() !== expectedWallet.toLowerCase()) {
        showWalletWarning(expectedWallet, connectedAddress);
    } else {
        hideWalletWarning();
    }

    hideTransactionStatus();
    showSuccess('Wallet connected successfully!');
    console.log('✅ Wallet connected successfully:', connectedAddress);
}

/**
 * Clean up after a wallet disconnect (user clicks Disconnect inside the AppKit
 * modal, or the wallet/session is torn down externally). Mirrors the inverse
 * of onWalletConnected.
 */
function onWalletDisconnected() {
    console.log('👛 Wallet disconnected');

    provider = null;
    signer = null;
    rewardEngineContract = null;
    connectedAddress = null;
    lastFinalizedAddress = null;

    elements.walletInfo.style.display = 'none';
    elements.connectWallet.textContent = 'Connect Wallet';
    elements.connectWallet.disabled = false;

    elements.addFulaToken.disabled = true;
    elements.checkRewards.disabled = true;
    elements.claimRewards.disabled = true;
    elements.claimRewards.textContent = 'Claim Rewards';

    elements.rewardsSection.style.display = 'none';
    if (elements.claimStatusSection) elements.claimStatusSection.style.display = 'none';
    if (elements.monthlyInfo) elements.monthlyInfo.style.display = 'none';

    catchUpState = null;
    hideCatchUpBanner();
    hideWalletWarning();

    updateConnectionStatus('Not Connected', '⚪');
}

/**
 * React to wallet-side network changes (user switches chain in their wallet
 * UI, or AppKit completes a switchNetwork() request). We trust the wallet as
 * the source of truth here: update the dropdown to match, hide stale rewards
 * UI, and re-init the signer + contract against the new chain.
 */
async function onNetworkChanged(newChainId) {
    if (!newChainId || !lastFinalizedAddress) return;

    const networkKey = Object.keys(NETWORKS).find(k => NETWORKS[k].chainId === newChainId);
    if (!networkKey) {
        // Wallet is on an unsupported chain. Disable contract-dependent actions
        // until the user switches back to SKALE or Base.
        rewardEngineContract = null;
        elements.checkRewards.disabled = true;
        elements.claimRewards.disabled = true;
        elements.connectedNetwork.textContent = `Chain ID: ${newChainId} (unsupported)`;
        return;
    }

    if (networkKey !== currentNetwork) {
        currentNetwork = networkKey;
        elements.networkSelect.value = networkKey;
        updateContractAddress();
    }

    // Stale rewards/claim UI — the user needs to re-check on the new chain.
    elements.rewardsSection.style.display = 'none';
    if (elements.claimStatusSection) elements.claimStatusSection.style.display = 'none';
    if (elements.monthlyInfo) elements.monthlyInfo.style.display = 'none';
    catchUpState = null;
    hideCatchUpBanner();
    elements.claimRewards.disabled = true;
    elements.claimRewards.textContent = 'Claim Rewards';

    // Re-grab provider/signer against the new chain and rebuild the contract.
    if (eip1193Provider) {
        try {
            provider = new ethers.BrowserProvider(eip1193Provider);
            signer = await provider.getSigner();
            const network = NETWORKS[currentNetwork];
            rewardEngineContract = new ethers.Contract(
                network.rewardEngineAddress,
                REWARD_ENGINE_ABI,
                signer
            );
            elements.connectedNetwork.textContent = network.name;
            elements.checkRewards.disabled = !validatePeerID(elements.peerIdInput.value.trim());
            console.log('✅ Re-initialized contract after chain change:', network.name);
        } catch (err) {
            console.error('Re-init after chain change failed:', err);
            showError(`Failed to switch contract to ${networkKey}: ${err.message}`);
        }
    }
}

/**
 * Open the AppKit wallet picker. Actual session establishment happens
 * asynchronously via the subscribers wired up in setupAppKitSubscribers().
 */
async function connectWallet() {
    try {
        console.log('🔗 Opening wallet picker...');
        if (!appKit) await initializeAppKit();
        await appKit.open();
    } catch (error) {
        console.error('❌ Wallet connection failed:', error);
        hideTransactionStatus();
        showError(`Wallet connection failed: ${error.message}`);
        updateConnectionStatus('Connection Failed', '🔴');
    }
}

/**
 * Switch wallet by disconnecting the current session and re-opening the
 * picker. Used by the "Switch Wallet" button in the wallet-mismatch banner.
 * Opening the Account view alone doesn't give a wallet picker — full
 * disconnect + reconnect is the correct path.
 */
async function switchWallet() {
    try {
        if (!appKit) {
            showError('Wallet picker is not ready yet. Please reload the page.');
            return;
        }
        showTransactionStatus('Disconnecting current wallet...', true);
        await appKit.disconnect();
        hideTransactionStatus();
        await appKit.open();
    } catch (error) {
        console.error('❌ Wallet switch failed:', error);
        hideTransactionStatus();
        showError(`Failed to switch wallet: ${error.message}`);
    }
}

/**
 * Poll the wallet's chain id until it matches `targetChainId` or the timeout
 * elapses. Rebuilds `provider`/`signer` on every iteration so a successful
 * return guarantees they're pointed at the new chain. Used after
 * `appKit.switchNetwork()` instead of a fixed sleep because real wallets vary
 * from <100ms (browser injected on a known chain) to many seconds (mobile WC
 * sessions, or the chain-add prompt for SKALE on a wallet that doesn't have
 * it yet).
 */
async function waitForChainId(targetChainId, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        provider = new ethers.BrowserProvider(eip1193Provider);
        const current = Number((await provider.getNetwork()).chainId);
        if (current === targetChainId) {
            signer = await provider.getSigner();
            return true;
        }
        await new Promise(r => setTimeout(r, 250));
    }
    return false;
}

/**
 * Initialize contract instance, switching the wallet's chain first if it
 * disagrees with `currentNetwork`. Chain switching goes through AppKit, which
 * internally handles both "switch to existing" and "add then switch" — the
 * legacy wallet_switchEthereumChain/wallet_addEthereumChain dance is no
 * longer needed at this layer.
 */
async function initializeContract() {
    try {
        const network = NETWORKS[currentNetwork];

        if (!provider || !signer || !eip1193Provider || !appKit) {
            throw new Error('Wallet not connected');
        }

        const currentChainId = Number((await provider.getNetwork()).chainId);
        if (currentChainId !== network.chainId) {
            console.log(`🔄 Switching from chain ${currentChainId} to ${network.chainId}`);
            await appKit.switchNetwork(APPKIT_CHAINS[currentNetwork]);

            // Poll rather than sleep-and-hope. subscribeNetwork will also fire
            // and rebuild via onNetworkChanged(), but the caller wants a usable
            // contract on return so we re-grab the signer ourselves once the
            // wallet confirms the switch.
            const switched = await waitForChainId(network.chainId);
            if (!switched) {
                throw new Error(`Failed to switch to ${network.name}. Please manually switch networks in your wallet.`);
            }
        }

        rewardEngineContract = new ethers.Contract(
            network.rewardEngineAddress,
            REWARD_ENGINE_ABI,
            signer
        );

        console.log('✅ Contract initialized:', network.rewardEngineAddress);
        updateContractAddress();
        elements.connectedNetwork.textContent = network.name;
    } catch (error) {
        console.error('❌ Contract initialization failed:', error);
        showError(`Contract initialization failed: ${error.message}`);
    }
}

/**
 * Populate the manual-add panel with the current network/token details and
 * show it. Safe to call repeatedly. Used both when the user explicitly clicks
 * the "Add FULA manually" link AND as the fallback when wallet_watchAsset
 * fails or times out on the underlying wallet (extremely common on mobile
 * WalletConnect sessions — many wallets either silently drop the method or
 * never surface a prompt).
 */
function showManualAddPanel() {
    const tokenConfig = CONFIG.FULA_TOKEN;
    if (elements.manualAddAddress) elements.manualAddAddress.textContent = tokenConfig.address;
    if (elements.manualAddSymbol) elements.manualAddSymbol.textContent = tokenConfig.symbol;
    if (elements.manualAddDecimals) elements.manualAddDecimals.textContent = String(tokenConfig.decimals);
    if (elements.manualAddNetwork) elements.manualAddNetwork.textContent = NETWORKS[currentNetwork]?.name ?? currentNetwork;
    if (elements.manualAddPanel) elements.manualAddPanel.style.display = 'block';
}

/**
 * Copy the text content of the element identified by `data-copy="<id>"` to
 * the clipboard. Wired via event delegation in initializeApp so future copy
 * buttons added to the manual-add panel don't need additional plumbing.
 */
async function handleCopyClick(event) {
    const btn = event.target.closest('.btn-copy');
    if (!btn) return;
    const targetId = btn.getAttribute('data-copy');
    if (!targetId) return;
    const sourceEl = document.getElementById(targetId);
    const text = sourceEl?.textContent?.trim();
    if (!text) return;

    try {
        await navigator.clipboard.writeText(text);
        const original = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => {
            btn.textContent = original;
            btn.classList.remove('copied');
        }, 1500);
    } catch (err) {
        console.warn('Clipboard write failed:', err);
        // Fallback: select the source text so the user can ⌘/Ctrl-C manually.
        const range = document.createRange();
        range.selectNodeContents(sourceEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }
}

/**
 * Add FULA token to the user's wallet using wallet_watchAsset, with a
 * timeout race so the UI doesn't hang forever when the wallet silently
 * drops the request. On any failure path (timeout / false / error), we
 * surface the manual-add panel so the user has a clear recovery option
 * regardless of wallet support.
 */
async function addFulaToken() {
    if (!eip1193Provider || !connectedAddress) {
        showError('Please connect your wallet first.');
        return;
    }

    const tokenConfig = CONFIG.FULA_TOKEN;
    console.log('🪙 Attempting wallet_watchAsset for FULA:', tokenConfig);
    showTransactionStatus('Sending request to your wallet — open your wallet app to approve...', true);

    const request = eip1193Provider.request({
        method: 'wallet_watchAsset',
        params: {
            type: 'ERC20',
            options: {
                address: tokenConfig.address,
                symbol: tokenConfig.symbol,
                decimals: tokenConfig.decimals,
            },
        },
    });

    // 12s is long enough for a user to switch to their wallet app and tap
    // approve, but short enough that the page doesn't feel broken when the
    // wallet drops the request entirely (the common mobile-WC failure mode).
    const TIMEOUT_MS = 12000;
    const TIMEOUT = Symbol('timeout');
    const timer = new Promise(resolve => setTimeout(() => resolve(TIMEOUT), TIMEOUT_MS));

    try {
        const result = await Promise.race([request, timer]);
        hideTransactionStatus();

        if (result === TIMEOUT) {
            console.log('⏳ wallet_watchAsset timed out — wallet likely does not support it over WalletConnect');
            showManualAddPanel();
            showError('Your wallet did not respond to the auto-add request (common on mobile WalletConnect). Use the details below to add FULA manually.');
            return;
        }

        if (result === true) {
            showSuccess('FULA token added to your wallet successfully!');
            console.log('✅ FULA token added to wallet');
        } else {
            // wallet returned false / null / undefined — usually means "cancelled"
            // or "method not supported and silently rejected".
            console.log('⚠️ wallet_watchAsset returned a falsy result:', result);
            showManualAddPanel();
            showError('Auto-add was cancelled or not supported by your wallet. Use the details below to add FULA manually.');
        }
    } catch (error) {
        hideTransactionStatus();
        console.error('❌ wallet_watchAsset threw:', error);

        if (error.code === 4001) {
            showError('Add-token request was rejected.');
            return;
        }

        // For any other error (method not in namespace, bridge error, etc.),
        // fall back to manual add — same end-user experience as a timeout.
        showManualAddPanel();
        showError(`Auto-add failed (${error.message || 'unknown error'}). Use the details below to add FULA manually.`);
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

        // Reset catch-up state on every check; only re-enable when probe confirms.
        catchUpState = null;
        hideCatchUpBanner();

        // Catch-up probe: if rewards == 0 but the user's effective claim start
        // is older than the contract's view window (MAX_VIEW_PERIODS_V2 *
        // expectedPeriod), the rewards view returned 0 only because their
        // online periods fall *outside* the visible window. The fix: surface
        // this to the user so they can advance their `lastClaimed` via
        // zero-reward "catch-up" claims (the contract's claim path handles
        // empty-period advancement). Skipped on rewards-fetch error and when
        // the monthly cap is the actual reason for zero rewards.
        if (totalRewards === 0n && !rewardsError) {
            try {
                // NOTE: do not query SECONDS_PER_MONTH() — the ABI lists it but
                // the deployed contract reverts on it. RewardEngine's
                // `_getCurrentMonth()` is hardcoded to `block.timestamp / 30 days`,
                // so we mirror that constant locally.
                const SECONDS_PER_MONTH_LOCAL = 30n * 24n * 60n * 60n;

                const [effectiveStartBN, expectedPeriodBN, maxViewPeriodsBN, maxMonthlyCap, latestBlock] =
                    await Promise.all([
                        rewardEngineContract.getEffectiveRewardStartTime(connectedAddress, peerIdBytes32, poolId),
                        rewardEngineContract.expectedPeriod(),
                        rewardEngineContract.MAX_VIEW_PERIODS_V2(),
                        rewardEngineContract.MAX_MONTHLY_REWARD_PER_PEER(),
                        provider.getBlock('latest')
                    ]);

                const now = BigInt(latestBlock.timestamp);
                const effectiveStart = BigInt(effectiveStartBN);
                const expectedPeriod = BigInt(expectedPeriodBN);
                const maxViewPeriods = BigInt(maxViewPeriodsBN);
                const windowSecs = maxViewPeriods * expectedPeriod;
                const currentMonth = now / SECONDS_PER_MONTH_LOCAL;

                // Cap check: if user already hit MAX_MONTHLY_REWARD_PER_PEER
                // for this peer this month, rewards = 0 is from the cap, not
                // staleness. The cap counter is mining-only and per-peer (see
                // RewardEngine.monthlyRewardsClaimed comment); claims on a
                // user's OTHER peers don't affect this entry. We don't bail on
                // failure here — if the cap query fails for any reason, prefer
                // showing catch-up over silently disabling the button.
                let isCapped = false;
                try {
                    const claimedThisMonth = await rewardEngineContract.monthlyRewardsClaimed(
                        peerIdBytes32, poolId, currentMonth
                    );
                    isCapped = BigInt(claimedThisMonth) >= BigInt(maxMonthlyCap);
                } catch (capErr) {
                    console.warn('Cap query failed (continuing without cap check):', capErr);
                }

                if (effectiveStart > 0n && now > effectiveStart && !isCapped) {
                    const timeSinceStart = now - effectiveStart;
                    if (timeSinceStart > windowSecs) {
                        // Stale. Probe recent online activity (last ~30 days)
                        // to distinguish "peer was offline, just came back"
                        // from "peer never came online". getOnlineStatusSince
                        // is capped at MAX_VIEW_PERIODS_V2 internally so a
                        // 30-day window is always within bounds.
                        const probeSince = now - BigInt(30 * 24 * 60 * 60);
                        let hasRecentActivity = false;
                        try {
                            const r = await rewardEngineContract.getOnlineStatusSince(
                                peerIdBytes32, poolId, probeSince
                            );
                            // r[0] = onlineCount over the window
                            hasRecentActivity = Number(r[0] ?? r.onlineCount ?? 0n) > 0;
                        } catch (probeErr) {
                            console.warn('Recent activity probe failed (non-fatal):', probeErr);
                        }

                        // ceil((timeSinceStart / expectedPeriod) / maxViewPeriods)
                        const periodsBehind = timeSinceStart / expectedPeriod;
                        const estClaims = Number(
                            (periodsBehind + maxViewPeriods - 1n) / maxViewPeriods
                        );

                        catchUpState = {
                            daysBehind: Number(timeSinceStart) / 86400,
                            estimatedCatchUpClaims: Math.max(1, estClaims),
                            hasRecentActivity
                        };
                        showCatchUpBanner(catchUpState);
                        console.log('⏳ Catch-up mode activated:', catchUpState);
                    }
                }
            } catch (probeErr) {
                console.warn('⚠️ Catch-up probe failed (non-fatal):', probeErr);
            }
        }

        // Enable claim button if there are rewards OR catch-up is required.
        // The pre-flight staticCall in claimRewards() will reject any call
        // that would actually revert on-chain, so enabling here is safe.
        elements.claimRewards.disabled = !(totalRewards > 0n || catchUpState);

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
                    // Prefer the catch-up estimate when stale — getClaimStatusV2
                    // returns 0 in that case because it only counts ONLINE
                    // periods within the 540-period view window.
                    const display = catchUpState
                        ? `${catchUpState.estimatedCatchUpClaims} (catch-up)`
                        : estimatedClaimsNeeded.toString();
                    elements.estimatedClaimsNeeded.textContent = display;
                }
                if (elements.hasMoreToClaim) {
                    if (catchUpState) {
                        elements.hasMoreToClaim.textContent = 'Catch-up required';
                        elements.hasMoreToClaim.style.color = '#b45309';
                    } else {
                        elements.hasMoreToClaim.textContent = hasMoreToClaim ? 'Yes - Multiple claims needed' : 'No - Single claim sufficient';
                        elements.hasMoreToClaim.style.color = hasMoreToClaim ? '#f39c12' : '#27ae60';
                    }
                }
                elements.claimStatusSection.style.display = 'block';
            }

            // Update claim button text. Catch-up takes priority over the
            // "~6 months worth" label since the latter implies real rewards.
            if (catchUpState) {
                elements.claimRewards.textContent = 'Advance Claim Window';
            } else if (hasMoreToClaim && totalRewards > 0n) {
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

        // Detect actual paid amount from receipt logs. The contract emits
        // MiningRewardsClaimed with amount=0 on catch-up calls (see
        // RewardEngine._claimRewardsInternalV2), so the only reliable way to
        // tell a real claim from an advance-only claim is to inspect events.
        let paidAmount = 0n;
        try {
            const iface = rewardEngineContract.interface;
            for (const log of (receipt.logs || [])) {
                // Only attempt parsing for events from THIS contract — logs
                // from token transfers (etc.) are in the same receipt and
                // would throw if we tried to parse them against this ABI.
                if (log.address && log.address.toLowerCase() !== rewardEngineContract.target.toLowerCase()) {
                    continue;
                }
                try {
                    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
                    if (parsed && (parsed.name === 'MiningRewardsClaimed' || parsed.name === 'StorageRewardsClaimed')) {
                        const amt = parsed.args.amount ?? parsed.args[3] ?? 0n;
                        paidAmount += BigInt(amt);
                    }
                } catch (_) { /* not one of our events */ }
            }
        } catch (e) {
            console.warn('Receipt decoding failed (non-fatal):', e);
        }

        // Message logic:
        //  - paidAmount > 0  : real claim (normal success message; may still
        //                      have more periods to fetch)
        //  - paidAmount == 0 + catchUpState : advance-only catch-up (expected)
        //  - paidAmount == 0 + !catchUpState : unusual (e.g. cap kicked in
        //                      between check and submit) — say so honestly.
        try {
            const [totalUnclaimedPeriods, , , , hasMoreToClaim] =
                await rewardEngineContract.getClaimStatusV2(connectedAddress, peerIdBytes32, poolId);

            if (paidAmount > 0n) {
                if (hasMoreToClaim && totalUnclaimedPeriods > 0n) {
                    showSuccess(`Rewards claimed successfully! You have ${totalUnclaimedPeriods} more periods to claim. Click "Check Rewards" and claim again.`);
                } else {
                    showSuccess(`Rewards claimed successfully! Transaction: ${receipt.hash}`);
                }
            } else if (catchUpState) {
                // Expected for catch-up txs: no rewards this call, window advanced.
                showSuccess(
                    `Claim window advanced (~6 months). No rewards were paid this transaction — ` +
                    `this was a catch-up step. Click "Check Rewards" to see whether more catch-up ` +
                    `is needed, or to claim accrued rewards. Tx: ${receipt.hash}`
                );
            } else {
                // Zero paid and we weren't in catch-up. Could be a monthly-cap
                // race or a same-period second click. Surface honestly.
                showSuccess(
                    `Transaction confirmed but no rewards were paid this call. ` +
                    `This usually means the monthly cap was reached or the window was already ` +
                    `up-to-date. Tx: ${receipt.hash}`
                );
            }
        } catch (statusErr) {
            // Fallback if status check fails — still surface the truth about paid amount.
            if (paidAmount > 0n) {
                showSuccess(`Rewards claimed successfully! Transaction: ${receipt.hash}`);
            } else {
                showSuccess(`Transaction confirmed. Tx: ${receipt.hash}`);
            }
        }

        // Refresh rewards display (also re-evaluates catch-up state)
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
 * Handle network selection change from the dropdown. If a wallet is connected,
 * ask AppKit to switch the wallet's chain to match; subscribeNetwork will then
 * fire and onNetworkChanged() will rebuild the contract. If the user rejects
 * the switch in their wallet, revert the dropdown so the UI stays consistent
 * with the wallet's actual chain instead of stranding the dropdown ahead of
 * reality.
 */
async function handleNetworkChange() {
    const previousNetwork = currentNetwork;
    const newNetwork = elements.networkSelect.value;
    if (previousNetwork === newNetwork) return;

    currentNetwork = newNetwork;
    console.log('🌐 Network changed to:', currentNetwork);

    rewardEngineContract = null;
    updateContractAddress();

    // Reset stale UI immediately so the user sees the network change reflect.
    elements.rewardsSection.style.display = 'none';
    if (elements.monthlyInfo) elements.monthlyInfo.style.display = 'none';
    if (elements.claimStatusSection) elements.claimStatusSection.style.display = 'none';
    catchUpState = null;
    hideCatchUpBanner();
    elements.claimRewards.disabled = true;
    elements.claimRewards.textContent = 'Claim Rewards';

    if (appKit && lastFinalizedAddress && APPKIT_CHAINS[currentNetwork]) {
        try {
            await appKit.switchNetwork(APPKIT_CHAINS[currentNetwork]);
            // onNetworkChanged (via subscribeNetwork) rebuilds the contract.
        } catch (err) {
            console.error('Network switch failed:', err);
            // Revert the dropdown to match the wallet's actual chain so the UI
            // doesn't drift ahead of reality.
            currentNetwork = previousNetwork;
            elements.networkSelect.value = previousNetwork;
            updateContractAddress();
            showError(`Failed to switch network: ${err.message}`);
        }
    }
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

    // Clear catch-up state on input change
    catchUpState = null;
    hideCatchUpBanner();

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
async function initializeApp() {
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

    // Manual-add FULA fallback: link toggles the panel; copy buttons inside
    // the panel are handled via delegated click so adding more rows later
    // doesn't need additional wiring.
    if (elements.showManualAdd) {
        elements.showManualAdd.addEventListener('click', (e) => {
            e.preventDefault();
            const isHidden = !elements.manualAddPanel || elements.manualAddPanel.style.display === 'none';
            if (isHidden) showManualAddPanel();
            else if (elements.manualAddPanel) elements.manualAddPanel.style.display = 'none';
        });
    }
    if (elements.manualAddPanel) {
        elements.manualAddPanel.addEventListener('click', handleCopyClick);
    }

    // Initialize contract address display
    updateContractAddress();

    // Display version
    const versionInfo = document.getElementById('versionInfo');
    if (versionInfo) {
        versionInfo.textContent = `v${VERSION}`;
    }

    // Initialize AppKit AFTER DOM listeners and URL params are wired up.
    // Subscribers fire immediately for any persisted session, so the UI must
    // be fully in place before they run — otherwise onWalletConnected() would
    // try to update DOM elements that haven't been bound yet (in practice
    // they have, because `elements` is captured at module load, but explicit
    // ordering avoids any latent surprise from this dependency).
    await initializeAppKit();

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
