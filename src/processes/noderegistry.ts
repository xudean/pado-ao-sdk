import { result, message, dryrun } from "@permaweb/aoconnect";
import { NODEREGISTRY_PROCESS_ID } from "../config";
import { getMessageResultData } from "./utils";

const register_or_update = async (action: string, name: string, pk: string, desc: string, signer: any) => {
  const msgId = await message({
    process: NODEREGISTRY_PROCESS_ID,
    tags: [
      { name: "Action", value: action },
      { name: "Name", value: name },
      { name: "Desc", value: desc },
    ],
    signer: signer,
    data: pk,
  });

  let Result = await result({
    message: msgId,
    process: NODEREGISTRY_PROCESS_ID,
  });

  const res = getMessageResultData(Result);
  return res;
}

export const register = async (name: string, pk: string, desc: string, signer: any) => {
  return await register_or_update('Register', name, pk, desc, signer);
}

export const update = async (name: string, desc: string, signer: any) => {
  return await register_or_update('Update', name, '', desc, signer);
}

export const deleteNode = async (name: string, signer: any) => {
  const msgId = await message({
    process: NODEREGISTRY_PROCESS_ID,
    tags: [
      { name: "Action", value: "Delete" },
      { name: "Name", value: name },
    ],
    signer: signer,
  });

  let Result = await result({
    message: msgId,
    process: NODEREGISTRY_PROCESS_ID,
  });

  const res = getMessageResultData(Result);
  return res;
}

export const nodes = async () => {
  let { Messages } = await dryrun({
    process: NODEREGISTRY_PROCESS_ID,
    tags: [
      { name: "Action", value: "Nodes" },
    ],
  });
  const nodes = Messages[0].Data;
  return nodes;
}

export const addWhiteList = async (addr: string, signer: any) => {
  const msgId = await message({
    process: NODEREGISTRY_PROCESS_ID,
    tags: [
      { name: "Action", value: "AddWhiteList" },
      { name: "Address", value: addr },
    ],
    signer: signer,
  });

  let Result = await result({
    message: msgId,
    process: NODEREGISTRY_PROCESS_ID,
  });

  const res = getMessageResultData(Result);
  return res;
}
