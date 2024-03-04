const bitcoin = require('bitcoinjs-lib');
const network = bitcoin.networks.bitcoin; // Use bitcoin.networks.testnet for testnet

// Provided details
const address = 'yourAddress'; // Not directly used in transaction creation, but good for validation
const wif = 'yourWIF';
const recipientAddress = 'recipientBitcoinAddress';
const amountToSend = 10000; // amount in satoshis
const miningFee = 1000; // fee in satoshis
const utxos = [
  {
    txId: 'transactionIdOfUtxo',
    vout: 0, // vout index of the UTXO
    value: 100000, // value of UTXO in satoshis
  },
  // Add more UTXOs if needed
];

// Create a new keyPair from WIF
const keyPair = bitcoin.ECPair.fromWIF(wif, network);

// Create a P2SH-P2WPKH (BIP49) address from the keyPair
const { address: p2shAddress, redeemScript } = bitcoin.payments.p2sh({
  redeem: bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network }),
  network,
});

// Ensure the provided address matches the generated one (for safety)
if (address !== p2shAddress) {
  throw new Error('The provided address does not match the address derived from WIF');
}

// Create a new transaction builder
const txb = new bitcoin.TransactionBuilder(network);

// Add inputs
utxos.forEach(utxo => {
  txb.addInput(utxo.txId, utxo.vout);
});

// Add output (recipient and change address)
const totalUtxoValue = utxos.reduce((acc, utxo) => acc + utxo.value, 0);
const change = totalUtxoValue - amountToSend - miningFee;

if (change < 0) {
  throw new Error('Insufficient funds for transaction and fee');
}

txb.addOutput(recipientAddress, amountToSend);

// Assuming the change is not dust, send it back to yourself
if (change > 0) {
  txb.addOutput(p2shAddress, change);
}

// Sign each input with the corresponding private key
utxos.forEach((utxo, index) => {
  txb.sign({
    prevOutScriptType: 'p2sh-p2wpkh',
    vin: index,
    keyPair: keyPair,
    redeemScript: redeemScript,
  });
});

// Build the transaction
const tx = txb.build();
const txHex = tx.toHex();

// txHex is the raw transaction in hexadecimal. You need to broadcast this to the network.
console.log('Transaction HEX:', txHex);

// Broadcasting `txHex` to the network depends on the Bitcoin network interface you're using.
// You might use a Bitcoin library or a third-party service API to do this.
