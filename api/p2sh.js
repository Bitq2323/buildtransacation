const axios = require('axios');
const bitcoin = require('bitcoinjs-lib');

module.exports = async (req, res) => {
  // Assuming parameters are provided in the request body for a POST request
  const {
    amountToSend, changeAddress, recipientAddress, utxosString,
    RBF, isBroadcast, transactionFee
  } = req.body;

  const network = bitcoin.networks.bitcoin; // Adjust for testnet or bitcoin as necessary
  const isBroadcastBool = isBroadcast === 'true' || isBroadcast === true;
  const RBFBool = RBF === 'true' || RBF === true;

  // Parse UTXOs string
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

  // Function to fetch raw transaction data
  async function fetchRawTransaction(txId) {
    try {
      const response = await axios.get(`https://blockchain.info/rawtx/${txId}?format=hex`);
      return response.data;
    } catch (error) {
      console.error('Error fetching raw transaction:', error);
      throw new Error('Error fetching raw transaction');
    }
  }

  // Function to broadcast the transaction
  async function broadcastTransaction(txHex) {
    try {
      const response = await axios.post('https://mempool.space/api/tx', txHex, {
        headers: { 'Content-Type': 'text/plain' }
      });
      return response.data; // Adjust based on API response format
    } catch (error) {
      console.error('Error broadcasting transaction:', error);
      throw new Error('Error broadcasting transaction');
    }
  }

  // Main function to create and optionally broadcast PSBT
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

    const totalAmountNeeded = parseInt(amountToSend) + parseInt(transactionFee);
    if (totalInputValue < totalAmountNeeded) {
      throw new Error('Insufficient funds for transaction and fee');
    }

    psbt.addOutput({
      address: recipientAddress,
      value: parseInt(amountToSend),
    });

    const change = totalInputValue - totalAmountNeeded;
    if (change > 546) { // Ensuring change is above dust threshold
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
      return await broadcastTransaction(txHex);
    } else {
      return {
        hex: txHex,
        virtualSize: tx.virtualSize(),
      };
    }
  }

  // Execute the PSBT creation and handle the response
  try {
    const result = await createPsbt();
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
``
