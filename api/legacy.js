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
  
  async function createP2PKHTx() {
    let psbt = new bitcoin.Psbt({ network: network });
  
    let totalInputValue = utxos.reduce((sum, utxo) => sum + utxo.value, 0);
    let requestedFee = parseInt(transactionFee);
  
    let recipientAddresses = recipientAddress.split(",");
    let amountsToSend = amountToSend.split(",").map(amount => parseInt(amount));
    let totalAmountToSend = amountsToSend.reduce((sum, amount) => sum + amount, 0);
  
    // Adjust the sending amount if total funds (minus fees) are insufficient
    if (totalAmountToSend + requestedFee > totalInputValue) {
      totalAmountToSend = totalInputValue - requestedFee;
      let totalRequestedAmount = amountsToSend.reduce((sum, amount) => sum + amount, 0);
      amountsToSend = amountsToSend.map(amount => Math.floor((amount / totalRequestedAmount) * totalAmountToSend));
    }

    for (const utxo of utxos) {
      const rawTx = await fetchRawTransaction(utxo.txid);
      psbt.addInput({
        hash: utxo.txid,
        index: utxo.vout,
        nonWitnessUtxo: Buffer.from(rawTx, 'hex'),
        sequence: RBFBool ? 0xfffffffd : 0xffffffff,
      });
    }
  
    recipientAddresses.forEach((address, index) => {
      const amount = amountsToSend[index];
      if (amount > 0) {
        psbt.addOutput({
          address: address,
          value: amount,
        });
      }
    });

    const change = totalInputValue - totalAmountToSend - requestedFee;
    if (change > 546) {
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
      const txid = await broadcastTransaction(txHex);
      return { txid: txid };
    } else {
      return { hex: txHex, virtualSize: tx.virtualSize() };
    }
  }
  
  try {
    const result = await createP2PKHTx();
    console.log('P2PKH Transaction Result:', result);
    res.status(200).json(result);
  } catch (error) {
    console.error('Error in createP2PKHTx:', error);
    res.status(500).json({ error: error.message });
  }
};
