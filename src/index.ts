import { createDataItemSigner } from '@permaweb/aoconnect';
import Arweave from 'arweave';
import { decrypt, encrypt, keygen, THRESHOLD_2_3 } from './algorithm';
import { COMPUTELIMIT, MEMORYLIMIT, TASKTYPE } from './config';
import type { CommonObject, DataItems, KeyInfo, nodeInfo, PriceInfo } from './index.d';
import { getDataFromAR, submitDataToAR } from './padoarweave';
import { allData, register as dataRegister, getDataById } from './processes/dataregistry';
import { nodes } from './processes/noderegistry';
import { getComputationPrice as fetchComputationPrice, getCompletedTasksById, submit } from './processes/tasks';
import { transferAOCREDToTask } from './processes/utils';


/**
 * Encrypt data and upload encrypted data to AR
 *
 * @param data - plain data need to encrypt and upload
 * @param dataTag - the data meta info object
 * @param priceInfo - The data price symbol(symbol is optional, default is AOCRED) and price. Currently only AO's test token AOCRED is supported, with a minimum price unit of 1 (1 means 0.001 AOCRED)
 * @param wallet - The ar wallet json object, this wallet must have AR Token
 * @param arweave - Arweave object generated by arweave-js init method and default is AR production
 * @returns The uploaded encrypted data id
 */
export const uploadData = async (
  data: Uint8Array,
  dataTag: CommonObject,
  priceInfo: PriceInfo,
  wallet: any,
  arweave: Arweave = Arweave.init({})
): Promise<string> => {
  if (data.length === 0) {
    throw new Error('The Data to be uploaded can not be empty');
  }

  // TODO: only support 2-3 at present
  let policy = {
    t: THRESHOLD_2_3.t,
    n: THRESHOLD_2_3.n,
    indices: [] as number[],
    names: [] as string[]
  };
  let nodeInfos = await _getNodeInfos(policy.n, true);

  let nodesPublicKey = [] as string[];
  for (let i = 0; i < nodeInfos.length; i++) {
    policy.indices.push(nodeInfos[i].index);
    policy.names.push(nodeInfos[i].name);
    nodesPublicKey.push(nodeInfos[i].pk);
  }

  const res = encrypt(nodesPublicKey, data, policy);
  const transactionId = await submitDataToAR(arweave, res.enc_msg, wallet);

  const signer = createDataItemSigner(wallet);
  let exData = {
    policy: policy,
    nonce: res.nonce,
    transactionId: transactionId,
    encSks: res.enc_sks
  };

  priceInfo.symbol = priceInfo.symbol || 'AOCRED';
  const dataRes = await dataRegister(
    JSON.stringify(dataTag),
    JSON.stringify(priceInfo),
    JSON.stringify(exData),
    signer
  );

  return dataRes;
};

/**
 * Get the all encrypted data info
 *
 * @returns Return Array of all data, each item contains id, dataTag, price, from and data fields
 */
export const listData = async (): Promise<DataItems> => {
  const resStr = await allData();
  const res = JSON.parse(resStr);
  return res;
};

/**
 * Generate private and public key pair
 *
 * @returns Return the key pair object which contains pk and sk fields
 */
export const generateKey = (): Promise<KeyInfo> => {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve(keygen());
    }, 1000);
  });
};

/**
 * Submit a task to PADO Network. And must pay the data fee corresponding to the dataId and the computing fee of the PADO Node. Now each task charges a certain amount of AOCRED(TestToken) per computing node,  and the getComputationPrice can get the amount.
 *
 * @param dataId - The data id
 * @param dataUserPk - The user's public key generated by keygen
 * @param wallet - The ar wallet json object, this wallet must have AOCRED(TestToken)
 * @returns The submited task id
 */
export const submitTask = async (dataId: string, dataUserPk: string, wallet: any): Promise<string> => {
  let encData = await getDataById(dataId);
  encData = JSON.parse(encData);
  const exData = JSON.parse(encData.data);
  const nodeNames = exData.policy.names;
  const priceObj = JSON.parse(encData.price);
  const symbol = priceObj.symbol;
  if (symbol !== 'AOCRED') {
    throw new Error('Only support AOCRED now');
  }
  const dataPrice = priceObj.price;
  //get node price
  const nodePrice = await fetchComputationPrice();
  const totalPrice = Number(dataPrice) + Number(nodePrice) * nodeNames.length;
  const signer = createDataItemSigner(wallet);
  try {
    await transferAOCREDToTask(totalPrice.toString(), signer);
  } catch (err) {
    if (err === 'Insufficient Balance!') {
      throw new Error(
        'Insufficient Balance! Please ensure that your wallet balance is greater than ' + totalPrice + ' AOCRED'
      );
    } else {
      throw err;
    }
  }

  let inputData = { dataId: dataId, consumerPk: dataUserPk };
  const taskId = await submit(
    TASKTYPE,
    dataId,
    JSON.stringify(inputData),
    COMPUTELIMIT,
    MEMORYLIMIT,
    nodeNames,
    signer
  );
  return taskId;
};

/**
 * Get the result of the task
 *
 * @param taskId The task id
 * @param dataUserSk - The user's secret key generated by keygen
 * @param arweave - Arweave object generated by arweave-js init method and default is AR production
 * @param timeout Timeout in milliseconds (default: 10 seconds)
 * @returns Return plain data
 */
export const getResult = async (
  taskId: string,
  dataUserSk: string,
  arweave: Arweave = Arweave.init({}),
  timeout: number = 10000
): Promise<Uint8Array> => {
  const taskStr = await _getCompletedTaskPromise(taskId, timeout);
  const task = JSON.parse(taskStr);

  if (task.verificationError) {
    throw task.verificationError;
  }

  let dataId = JSON.parse(task.inputData).dataId;
  let encData = await getDataById(dataId);
  encData = JSON.parse(encData);
  let exData = JSON.parse(encData.data);

  // TODO: since only support THRESHOLD_2_3 at present, we choice the first t nodes
  let chosenIndices = [];
  let reencChosenSks = [];
  for (let i = 0; i < THRESHOLD_2_3.t; i++) {
    let index = exData.policy.indices[i];
    chosenIndices.push(index);

    let name = exData.policy.names[i];
    const reencSksObj = JSON.parse(task.result[name]);
    reencChosenSks.push(reencSksObj.reenc_sk);
  }
  const encMsg = await getDataFromAR(arweave, exData.transactionId);
  const res = decrypt(reencChosenSks, dataUserSk, exData.nonce, encMsg, chosenIndices);
  return new Uint8Array(res.msg);
};

/**
 * Submit a task to AO and get the result. The combination of submitTask and getResult
 *
 * @param dataId - The data id
 * @param pk - The user's public key generated by keygen
 * @param sk - The user's secret key generated by keygen
 * @param wallet - The ar wallet json object, this wallet must have AOCRED(TestToken)
 * @param arweave - Arweave object generated by arweave-js init method and default is AR production
 * @param timeout Timeout in milliseconds (default: 10 seconds)
 * @returns Return plain data
 */
export const submitTaskAndGetResult = async (
  dataId: string,
  dataUserPk: string,
  dataUserSk: string,
  wallet: any,
  arweave: Arweave = Arweave.init({}),
  timeout: number = 10000
) => {
  const taskId = await submitTask(dataId, dataUserPk, wallet);
  const result = await getResult(taskId, dataUserSk, arweave, timeout);
  return result;
};

/**
 * Get the computing price of each node for each task. Now only supports AO’s test token AOCRED, minimum unit to use AOCRED(1 means 0.001 AOCRED)
 *
 * @returns The computing price of a node
 */
export const getComputationPrice = async (): Promise<string> => {
  const res = await fetchComputationPrice();
  return res;
};

/**
 * Get node infos
 *
 * @param n - How many nodes to select
 * @param random - Whether randomly selected
 * @returns The node infos
 */
const _getNodeInfos = async (n: number, random: boolean = false): Promise<Array<nodeInfo>> => {
  let nodesres = await nodes();
  nodesres = JSON.parse(nodesres);
  if (nodesres.length < n) {
    throw `Insufficient number of nodes, expect ${n}, actual ${nodesres.length}`;
  }

  let selected_indices = Array.from({ length: nodesres.length }, (_, i) => i);
  if (random) {
    selected_indices.sort(function () {
      return 0.5 - Math.random();
    });
  }

  let nodeInfos: Array<nodeInfo> = [];
  for (let i = 0; i < n; i++) {
    let node = nodesres[selected_indices[i]];
    nodeInfos.push({
      org_index: parseInt(node.index),
      index: parseInt(node.index),
      name: node.name,
      pk: node.publickey
    });
  }

  // it's ok, no matter sorted or not
  // nodeInfos.sort((a, b) => a.org_index - b.org_index);

  // re-index, do not care original index
  for (var i = 0; i < nodeInfos.length; i++) {
    nodeInfos[i].index = i + 1;
  }
  return nodeInfos;
};

const _getCompletedTaskPromise = (taskId: string, timeout: number): Promise<string> => {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const tick = async () => {
      const timeGap = performance.now() - start;
      const taskStr = await getCompletedTasksById(taskId);
      const task = JSON.parse(taskStr);
      if (task.id) {
        resolve(taskStr);
      } else if (timeGap > timeout) {
        reject('timeout');
      } else {
        setTimeout(tick, 500);
      }
    };
    tick();
  });
};