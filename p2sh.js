const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');
const network = bitcoin.networks.bitcoin; // Use bitcoin.networks.testnet for testnet

// New parameters
const amountToSend = 5000; // Amount to send in satoshis
const changeAddress = '32dpHJAsEgDUPYwsvZgD4fKdBvk3SAygdj'; // Change address
const shouldUseAllUtxos = false; // Control whether to use all UTXOs or not
const dustThreshold = 546; // Define dust threshold (in satoshis), adjust as needed

// New parameters for RBF and broadcasting
const RBF = true; // Enable or disable RBF
const isBroadcast = false; // Control broadcasting

// Recipient address and transaction fee
const recipientAddress = '3LBuSCkR5d9CEHqG9cYsFyMAQNSrnfuCxJ';
const transactionFee = 5000; // Fee in satoshis

// UTXOs provided as a string
const utxosString = "txid:25678908869df04db95791a4f50a7943f751272ddd4784183bfb2a29588f2e28, vout:0, value:15851, wif:L3k1jKsP8x4zAhjdVt2aCC1rZBgBYm5KrHE6M8edK7ZUqU1TCG8e|txid:96bc93a16ee5566d26e682f8d300ad11130db811cc5617d55bd9df4f0f25229d, vout:0, value:10000, wif:L16pT3EBZwa7F2ckSxDnm3CY6o1tUzBf3X2ShYjMby4kCoJbF5ib";

const utxos = utxosString.split("|").map(utxoString => {
  const utxoParts = utxoString.split(", ").reduce((acc, part) => {
    const [key, value] = part.split(":");
    acc[key] = key === 'vout' || key === 'value' ? parseInt(value, 10) : value;
    return acc;
  }, {});

  return {
    txid: utxoParts.txid,
    vout: utxoParts.vout,
    value: utxoParts.value,
    wif: utxoParts.wif
  };
});

async function fetchRawTransaction(txId) {
  try {
    const response = await axios.get(`https://blockchain.info/rawtx/${txId}?format=hex`);
    return response.data;
  } catch (error) {
    console.error('Error fetching raw transaction:', error);
    throw error;
  }
}

// Function to broadcast transaction
async function broadcastTransaction(txHex) {
  try {
    const response = await axios.post('https://mempool.space/api/tx', txHex, {
      headers: { 'Content-Type': 'text/plain' }
    });
    return response.data; // Adjust based on API response format
  } catch (error) {
    console.error('Error broadcasting transaction:', error);
    throw error;
  }
}

async function createPsbt() {
  let psbt = new bitcoin.Psbt({ network: network });
  let totalInputValue = 0;
  let inputsAdded = [];

  // Sort UTXOs by value in descending order
  utxos.sort((a, b) => b.value - a.value);

  for (const utxo of utxos) {
    if (shouldUseAllUtxos || totalInputValue < (amountToSend + transactionFee)) {
      const rawTx = await fetchRawTransaction(utxo.txid);
      const keyPair = bitcoin.ECPair.fromWIF(utxo.wif, network);
      const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network });
      const p2sh = bitcoin.payments.p2sh({ redeem: p2wpkh, network });

      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        nonWitnessUtxo: Buffer.from(rawTx, 'hex'),
        redeemScript: p2sh.redeem.output,
        sequence: RBF ? 0xfffffffd : 0xffffffff, // Set sequence for RBF
      });
      
      totalInputValue += utxo.value;
      inputsAdded.push({utxo, keyPair});
    }
  }

  // Verify if sufficient funds are available
  if (totalInputValue < (amountToSend + transactionFee)) {
    throw new Error('Insufficient funds for transaction and fee');
  }

  // Add recipient output
  psbt.addOutput({
    address: recipientAddress,
    value: amountToSend,
  });

  const change = totalInputValue - amountToSend - transactionFee;

  // Add change output if above dust threshold
  if (change >= dustThreshold) {
    psbt.addOutput({
      address: changeAddress,
      value: change,
    });
  }

  // Sign inputs
  inputsAdded.forEach(({utxo, keyPair}, index) => {
    psbt.signInput(index, keyPair);
  });

  // Finalize PSBT after all inputs and outputs are added
  psbt.finalizeAllInputs();

  // Extract transaction and decide on broadcasting or logging
  const tx = psbt.extractTransaction();
  const txHex = tx.toHex();
  const txVirtualSize = tx.virtualSize();

  if (isBroadcast) {
    try {
      const broadcastResult = await broadcastTransaction(txHex);
      console.log('Transaction broadcasted, txID:', broadcastResult.txid); // Adjust logging based on actual API response
    } catch (error) {
      console.error('Failed to broadcast transaction:', error);
    }
  } else {
    console.log('Transaction HEX:', txHex);
    console.log('Transaction Virtual Size:', txVirtualSize);
  }
}

createPsbt().catch(console.error);
