import { logGasUsage } from "./gas";
import { bigNumberify, expandDecimals } from "./math";
import { getOracleParams, getOracleParamsForSimulation, TOKEN_ORACLE_TYPES } from "./oracle";

export function getExecuteParams(fixture, { tokens }) {
  const { wnt, wbtc, usdc } = fixture.contracts;
  const priceInfoItems = {
    [wnt.address]: {
      precision: 8,
      minPrice: expandDecimals(5000, 4),
      maxPrice: expandDecimals(5000, 4),
    },
    [wbtc.address]: {
      precision: 20,
      minPrice: expandDecimals(50000, 2),
      maxPrice: expandDecimals(50000, 2),
    },
    [usdc.address]: {
      precision: 18,
      minPrice: expandDecimals(1, 6),
      maxPrice: expandDecimals(1, 6),
    },
  };

  const params = {
    tokens: [],
    precisions: [],
    minPrices: [],
    maxPrices: [],
  };

  for (let i = 0; i < tokens.length; i++) {
    const priceInfoItem = priceInfoItems[tokens[i].address];
    if (!priceInfoItem) {
      throw new Error("Missing price info");
    }
    params.tokens.push(tokens[i].address);
    params.precisions.push(priceInfoItem.precision);
    params.minPrices.push(priceInfoItem.minPrice);
    params.maxPrices.push(priceInfoItem.maxPrice);
  }

  return params;
}

export async function executeWithOracleParams(fixture, overrides) {
  const { key, oracleBlocks, oracleBlockNumber, tokens, precisions, minPrices, maxPrices, execute, gasUsageLabel } =
    overrides;
  const { provider } = ethers;
  const { signers } = fixture.accounts;
  const { oracleSalt, signerIndexes } = fixture.props;

  const block = await provider.getBlock(bigNumberify(oracleBlockNumber).toNumber());
  const tokenOracleTypes =
    overrides.tokenOracleTypes || Array(tokens.length).fill(TOKEN_ORACLE_TYPES.DEFAULT, 0, tokens.length);

  let minOracleBlockNumbers = [];
  let maxOracleBlockNumbers = [];
  let oracleTimestamps = [];
  let blockHashes = [];

  if (oracleBlocks) {
    for (let i = 0; i < oracleBlocks.length; i++) {
      const oracleBlock = oracleBlocks[i];
      minOracleBlockNumbers.push(oracleBlock.number);
      maxOracleBlockNumbers.push(oracleBlock.number);
      oracleTimestamps.push(oracleBlock.timestamp);
      blockHashes.push(oracleBlock.hash);
    }
  } else {
    minOracleBlockNumbers =
      overrides.minOracleBlockNumbers || Array(tokens.length).fill(block.number, 0, tokens.length);

    maxOracleBlockNumbers =
      overrides.maxOracleBlockNumbers || Array(tokens.length).fill(block.number, 0, tokens.length);

    oracleTimestamps = overrides.oracleTimestamps || Array(tokens.length).fill(block.timestamp, 0, tokens.length);

    blockHashes = Array(tokens.length).fill(block.hash, 0, tokens.length);
  }

  const args = {
    oracleSalt,
    minOracleBlockNumbers,
    maxOracleBlockNumbers,
    oracleTimestamps,
    blockHashes,
    signerIndexes,
    tokens,
    tokenOracleTypes,
    precisions,
    minPrices,
    maxPrices,
    signers,
    priceFeedTokens: [],
  };

  let oracleParams;
  if (overrides.simulate) {
    oracleParams = await getOracleParamsForSimulation(args);
  } else {
    oracleParams = await getOracleParams(args);
  }

  return await logGasUsage({
    tx: execute(key, oracleParams),
    label: gasUsageLabel,
  });
}
