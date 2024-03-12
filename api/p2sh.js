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
    const parts = utxoString.split(","); // Split by comma first to separate txid:vout, value, and wif
    const txidVout = parts[0].split(":"); // Further split the first part to separate txid and vout
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
      console.log("Broadcast Response:", response.data); // Log the response data
      return response.data;
    } catch (error) {
      console.error('Error broadcasting transaction:', error);
      throw new Error('Error broadcasting transaction: ' + error.message);
    }
  }
  
  async function createPsbt() {
    let psbt = new bitcoin.Psbt({ network: network });
    let totalInputValue = 0;
  
    for (const utxo of utxos) {
      if (!utxo.txid) {
        console.error('Undefined txid in UTXOs:', JSON.stringify(utxo));
        throw new Error('Undefined txid in UTXOs, check your input format.');
      }
  
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
  
      totalInputValue += utxo.value;
    }
  
    // Split recipient addresses and amounts
    const recipientAddresses = recipientAddress.split(",");
    const amountsToSend = amountToSend.split(",").map(amount => parseInt(amount));
  
    let totalAmountToSend = 0;
  
    // Add each recipient as an output
    recipientAddresses.forEach((address, index) => {
      const amount = amountsToSend[index];
      if (amount) {
        psbt.addOutput({
          address: address,
          value: amount,
        });
        totalAmountToSend += amount;
      } else {
        throw new Error('Mismatch between recipient addresses and amounts');
      }
    });
  
    const requestedFee = parseInt(transactionFee);
    const totalAmountNeeded = totalAmountToSend + requestedFee;
  
    if (totalInputValue < totalAmountNeeded) {
      throw new Error('Insufficient funds to cover the transaction and fees');
    }
  
    const change = totalInputValue - totalAmountToSend - requestedFee;
    if (change > 546) { // Dust threshold
      psbt.addOutput({
        address: changeAddress,
        value: change,
      });
    }
  
    utxos.forEach(({ wif }, index) => {
      const keyPair = bitcoin.ECPair.fromWIF(wif, network);
      psbt.signInput(index, keyPair);
    });
  
    psbt.finalizeAllInputs();
  
    const tx = psbt.extractTransaction();
    const txHex = tx.toHex();
  
    if (isBroadcastBool) {
      const txid = await broadcastTransaction(txHex); // This directly returns the txID as a string
      return { txid: txid }; // Use the txID directly
    } else {
      return { hex: txHex, virtualSize: tx.virtualSize() };
    }
  }
  
  try {
    const result = await createPsbt();
    console.log('PSBT Result:', result);
    res.status(200).json(result);
  } catch (error) {
    console.error('Error in createPsbt:', error);
    res.status(500).json({ error: error.message });
  }
};
