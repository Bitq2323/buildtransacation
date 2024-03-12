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

    let actualAmountToSend = parseInt(amountToSend);
    const requestedFee = parseInt(transactionFee);
    const totalAmountNeeded = actualAmountToSend + requestedFee;

    if (totalInputValue < totalAmountNeeded) {
      const availableForSending = totalInputValue - requestedFee;
      if (availableForSending > 0) {
        actualAmountToSend = availableForSending;
      } else {
        throw new Error('Insufficient funds to cover the fee');
      }
    }

    psbt.addOutput({
      address: recipientAddress,
      value: actualAmountToSend,
    });

    const change = totalInputValue - actualAmountToSend - requestedFee;
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
