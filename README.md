# Reward Engine Portal

A production-ready web application for claiming mining and storage rewards from the RewardEngine smart contract deployed on Base and SKALE networks.

## Features

- 🌐 **Multi-Network Support**: Works with both Base and SKALE mainnet
- 👛 **Wallet Integration**: Seamless MetaMask connection with automatic network switching
- 🔄 **PeerID Conversion**: Automatic conversion from PeerID to bytes32 format for contract calls
- 💰 **Reward Checking**: View available mining and storage rewards before claiming
- 🛡️ **Production Security**: Comprehensive error handling and input validation
- 📱 **Mobile Responsive**: Works on both desktop and mobile devices
- ⚡ **Real-time Updates**: Live transaction status and confirmation tracking

## Quick Start

### Prerequisites

- MetaMask browser extension installed
- Access to Base or SKALE mainnet
- A valid PeerID for reward checking

### Deployment to GitHub Pages

1. **Fork or clone this repository**
2. **Update contract addresses** in `app.js`:
   ```javascript
   const NETWORKS = {
       skale: {
           rewardEngineAddress: "YOUR_SKALE_CONTRACT_ADDRESS",
           // ... other config
       },
       base: {
           rewardEngineAddress: "YOUR_BASE_CONTRACT_ADDRESS", 
           // ... other config
       }
   };
   ```
3. **Enable GitHub Pages** in repository settings
4. **Select source**: Deploy from main branch
5. **Access your portal**: `https://yourusername.github.io/repository-name`

### Local Development

1. **Clone the repository**:
   ```bash
   git clone <repository-url>
   cd mainnet-claim
   ```

2. **Serve locally** (Python example):
   ```bash
   python -m http.server 8000
   ```

3. **Open browser**: Navigate to `http://localhost:8000`

## Usage

### Connecting Your Wallet

1. Click "Connect Wallet" button
2. Approve MetaMask connection request
3. The app will automatically switch to the selected network
4. Your wallet address will be displayed once connected

### Checking Rewards

1. Select your preferred network (SKALE recommended)
2. Enter your PeerID in the input field
3. Optionally adjust the Pool ID (default: 1)
4. Click "Check Rewards" to view available tokens

### Claiming Rewards

1. After checking rewards, click "Claim Rewards" if tokens are available
2. Confirm the transaction in MetaMask
3. Wait for transaction confirmation
4. Your rewards will be transferred to your connected wallet

## Network Configuration

### SKALE Mainnet
- **Chain ID**: 2046399126
- **RPC URL**: https://mainnet.skalenodes.com/v1/elated-tan-skat
- **Explorer**: https://elated-tan-skat.explorer.mainnet.skalenodes.com

### Base Mainnet  
- **Chain ID**: 8453
- **RPC URL**: https://base-mainnet.g.alchemy.com/v2/_LnQrpSkygkgsX96sfS_fMl78FeAHnhw
- **Explorer**: https://basescan.org

## PeerID Format

The application supports both PeerID formats:
- **CIDv1 format**: Starts with 'z' (e.g., `z12D3KooW...`)
- **Legacy multihash**: Base58 encoded (e.g., `12D3KooW...`)

PeerIDs are automatically converted to bytes32 format for smart contract interaction.

## Smart Contract Integration

The portal interacts with the RewardEngine contract using these functions:

- `calculateEligibleMiningRewards(address, bytes32, uint32)`: Check mining rewards
- `calculateEligibleStorageRewards(address, bytes32, uint32)`: Check storage rewards  
- `claimRewards(bytes32, uint32)`: Claim available rewards

## Error Handling

The application includes comprehensive error handling for:

- **Wallet Connection**: MetaMask not installed, account locked, etc.
- **Network Issues**: Wrong network, RPC failures, connection timeouts
- **Transaction Errors**: Insufficient gas, rejected transactions, contract reverts
- **Input Validation**: Invalid PeerID format, missing required fields
- **Contract Errors**: No rewards available, circuit breaker active, etc.

## Security Features

- ✅ Input validation and sanitization
- ✅ Network verification before transactions
- ✅ Gas limit protection
- ✅ Transaction timeout handling
- ✅ Error message sanitization
- ✅ No private key handling (MetaMask only)

## Browser Compatibility

- Chrome/Chromium (recommended)
- Firefox
- Safari (with MetaMask extension)
- Edge
- Mobile browsers with MetaMask mobile app

## Troubleshooting

### Common Issues

**"MetaMask not detected"**
- Install MetaMask browser extension
- Refresh the page after installation

**"Wrong network"** 
- The app will automatically prompt to switch networks
- Manually switch to Base or SKALE in MetaMask if needed

**"Transaction failed"**
- Check you have sufficient ETH for gas fees
- Verify the contract isn't paused (circuit breaker)
- Ensure you have rewards available to claim

**"Invalid PeerID"**
- Verify PeerID format (should be 44+ characters)
- Include 'z' prefix for CIDv1 format if needed
- Check for typos in the PeerID

### Getting Help

1. Check browser console for detailed error logs
2. Verify contract addresses are correctly configured
3. Test with a small amount first
4. Ensure MetaMask is unlocked and connected

## Development

### File Structure
```
├── index.html          # Main HTML structure
├── app.js             # Application logic and Web3 integration  
├── styles.css         # Responsive CSS styling
├── contracts/         # Contract ABI files
│   └── RewardEngine.json
└── README.md          # This file
```

### Key Dependencies
- **Ethers.js v6**: Web3 library for blockchain interaction
- **MetaMask**: Browser wallet for transaction signing
- **Base58**: PeerID encoding/decoding utilities

### Configuration

Update contract addresses in `app.js`:
```javascript
// Replace with actual deployed contract addresses
rewardEngineAddress: "0x..." // Your contract address here
```

## License

This project is open source and available under the MIT License.

## Support

For technical support or questions about the RewardEngine contract, please refer to the official documentation or contact the development team.
