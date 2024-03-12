const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');

module.exports = async (req, res) => {
  console.log('Received Request Body:', JSON.stringify(req.body, null, 2));

  const {
    amountToSend, changeAddress, recipientAddress, utxosString,
    RBF, isBroadcast, transactionFee
  } = req.body;

  const network = bitcoin.networks.bitcoin;
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
    const recipientAddresses = recipientAddress.split(",");
    const amountsToSend = amountToSend.split(",").map(amount => parseInt(amount));
    let totalAmountToSend = amountsToSend.reduce((sum, amount) => sum + amount, 0);
    const requestedFee = parseInt(transactionFee);
    let proportions = amountsToSend.map(amount => amount / totalAmountToSend);

    if (totalAmountToSend + requestedFee > totalInputValue) {
      totalAmountToSend = totalInputValue - requestedFee;
      amountsToSend = proportions.map(prop => Math.floor(totalAmountToSend * prop));
    }

    // Adjust for exact fee deduction if total balance is used
    let totalAmountAfterFee = totalAmountToSend - requestedFee;
    if (totalAmountAfterFee < 0) {
      throw new Error('Insufficient funds to cover the transaction and fees');
    }

    // Add inputs
    for (const utxo of utxos) {
      const rawTx = await fetchRawTransaction(utxo.txid);
      const keyPair = bitcoin.ECPair.fromWIF(utxo.wif, network);
      const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: keyPair.publicKey, network });
      const p2sh = bitcoin.payments.p2sh({ redeem: p2wpkh, network });

      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        nonWitnessUtxo: Buffer.from(rawTx, 'hex'),
        redeemScript: p2sh.redeem.output,
        sequence: RBFBool ? 0xfffffffd : 0xffffffff,
      });
    }

    // Add outputs
    recipientAddresses.forEach((address, index) => {
      const amount = amountsToSend[index];
      if (amount) {
        psbt.addOutput({
          address: address,
          value: amount,
        });
      }
    });

    // Check if there's need for change output
    const totalOutputValue = amountsToSend.reduce((acc, amount) => acc + amount, 0) + requestedFee;
    const change = totalInputValue - totalOutputValue;
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

    // Finalize all inputs and extract the transaction
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    const txHex = tx.toHex();

    // Decide whether to broadcast the transaction or return its details
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

  // Execute the transaction creation and handling logic
  try {
    const result = await createPsbt();
    console.log('Transaction creation result:', result);
    res.status(200).json(result);
  } catch (error) {
    console.error('Error in transaction creation:', error);
    res.status(500).json({ error: error.message });
  }
};

