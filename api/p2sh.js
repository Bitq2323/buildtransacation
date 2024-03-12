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

    let sendAmount = parseInt(amountToSend);
    const totalAmountNeeded = sendAmount + parseInt(transactionFee);

    // Check if total UTXO value is less than the required amount (send + fee)
    if (totalInputValue < totalAmountNeeded) {
        console.log('Not enough funds to cover both amountToSend and transactionFee. Adjusting send amount.');
        // Adjust sendAmount to fit within available balance, deducting the fee
        sendAmount = totalInputValue - parseInt(transactionFee);
        
        // Ensure the sendAmount does not become negative after adjustment
        if (sendAmount < 0) {
            throw new Error('Total UTXO balance is less than the transaction fee. Unable to proceed.');
        }
    }

    // Add outputs
    psbt.addOutput({
        address: recipientAddress,
        value: sendAmount, // Use adjusted sendAmount
    });

    const change = totalInputValue - sendAmount - parseInt(transactionFee);
    if (change > 546) { // Add change output if above dust threshold
        psbt.addOutput({
            address: changeAddress,
            value: change,
        });
    }

    // Sign each input
    utxos.forEach(({ wif }, index) => {
        const keyPair = bitcoin.ECPair.fromWIF(wif, network);
        psbt.signInput(index, keyPair);
    });

    psbt.finalizeAllInputs();

    const tx = psbt.extractTransaction();
    const txHex = tx.toHex();

    // Handle broadcasting or return the transaction hex
    if (isBroadcastBool) {
        const broadcastResult = await broadcastTransaction(txHex);
        return { txid: broadcastResult.txid };
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
