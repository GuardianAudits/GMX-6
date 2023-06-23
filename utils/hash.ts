import { ethers } from "ethers";

export function encodeData(dataTypes, dataValues) {
  const bytes = ethers.utils.defaultAbiCoder.encode(dataTypes, dataValues);
  return ethers.utils.hexlify(bytes);
}

export function hashData(dataTypes, dataValues) {
  const bytes = ethers.utils.defaultAbiCoder.encode(dataTypes, dataValues);
  const hash = ethers.utils.keccak256(ethers.utils.arrayify(bytes));

  return hash;
}

export function hashString(string) {
  return hashData(["string"], [string]);
}
