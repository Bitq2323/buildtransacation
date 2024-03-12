const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');

module.exports = async (req, res) => {
  console.log('Received Request Body:', JSON.stringify(req.body, null, 2));

  const {
    amountToSend, changeAddress, recipientAddress, utxosString,
    RBF, isBroadcast, transactionFee
  } = req.body;

  const network = bitcoin.networks.bitcoin; // For mainnet, use bitcoin.networks.bitcoin
  const isBroadcastBool = isBroadcast === 'true' || isBroadcast === true;
  const RBFBool = RBF === 'true' || RBF === true;

  const utxos = utxosString.split("|").map(utxoString => {
    const parts = utxoString.split(",");
    const txidVout = parts[0].split(":");
    return {
      txid: txidVout[0],
      vout: parseInt(txidVout[1], 10),
      value: parseInt(parts[1], 10),
      wif: parts[2]
    };
  });

  console.log('Parsed UTXOs:', JSON.stringify(utxos, null, 2));

  async function fetchRawTransaction(txId) {
    try {
      const response = await axios.get(`https://blockchain.info/rawtx/${txId}?format=hex`);
      return response.data;
    } catch (error) {
      console.error('Error fetching raw transaction:', error);
      throw new Error('Error fetching raw transaction: ' + error.message);
    }
  }

  async function broadcastTransaction(txHex) {
    try {
      const response = await axios.post('https://mempool.space/api/tx', txHex, {
        headers: { 'Content-Type': 'text/plain' }
      });
      console.log("Broadcast Response:", response.data);
      return response.data;
    } catch (error) {
      console.error('Error broadcasting transaction:', error);
      throw new Error('Error broadcasting transaction: ' + error.message);
    }
  }

  async function createPsbt() {
    let psbt = new bitcoin.Psbt({ network: network });
    let totalInputValue = utxos.reduce((sum, utxo) => sum + utxo.value, 0);
    let requestedFee = parseInt(transactionFee);
  
    let recipientAddresses = recipientAddress.split(",");
    let amountsToSend = amountToSend.split(",").map(amount => parseInt(amount));
    let totalAmountToSend = amountsToSend.reduce((sum, amount) => sum + amount, 0);
  
    // Adjust the sending amount if total funds (minus fees) are insufficient
    if (totalAmountToSend + requestedFee > totalInputValue) {
      // Use the whole balance minus the fee for sending
      totalAmountToSend = totalInputValue - requestedFee;
      // Adjust the amounts to send if there are multiple recipients, proportionally
      let totalRequestedAmount = amountsToSend.reduce((sum, amount) => sum + amount, 0);
      amountsToSend = amountsToSend.map(amount => Math.floor((amount / totalRequestedAmount) * totalAmountToSend));
    }
  
    // Add inputs for P2WPKH
    for (const utxo of utxos) {
      const rawTx = await fetchRawTransaction(utxo.txid);
      const keyPair = bitcoin.ECPair.fromWIF(utxo.wif, network);
      const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network });

      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        witnessUtxo: {
          script: p2wpkh.output,
          value: utxo.value,
        },
        sequence: RBFBool ? 0xfffffffd : 0xffffffff,
      });
    }

    // Add outputs directly to recipient(s) (Bech32 addresses)
    recipientAddresses.forEach((address, index) => {
      let amount = amountsToSend[index];
      if (amount) {
        psbt.addOutput({
          address: address,
          value: amount,
        });
      }
    });

    let totalOutputValue = amountsToSend.reduce((acc, amount) => acc + amount, 0) + requestedFee;
    let change = totalInputValue - totalOutputValue;
    if (change > 546) { // Dust threshold
      psbt.addOutput({
          address: changeAddress,
          value: change,
      });
    }

    // Sign each input with the corresponding private key
    utxos.forEach((utxo, index) => {
        const keyPair = bitcoin.ECPair.fromWIF(utxo.wif, network);
        psbt.signInput(index, keyPair);
    });
    
    // Finalize all inputs. For P2WPKH, finalization is simpler due to witness data structure
    psbt.finalizeAllInputs();
    
    const tx = psbt.extractTransaction();
    const txHex = tx.toHex();
    
    if (isBroadcastBool) {
        try {
            const broadcastResult = await broadcastTransaction(txHex);
            console.log('Broadcast result:', broadcastResult);
            return { txid: broadcastResult };
        } catch (error) {
            console.error('Broadcast error:', error);
            throw new Error('Failed to broadcast transaction: ' + error.message);
        }
    } else {
        return { hex: txHex, virtualSize: tx.virtualSize() };
    }
}
try {
const result = await createPsbt();
console.log('Transaction creation result:', result);
res.status(200).json(result);
} catch (error) {
console.error('Error in transaction creation:', error);
res.status(500).json({ error: error.message });
}
};

