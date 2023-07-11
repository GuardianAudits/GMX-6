import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat, bigNumberify } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, handleOrder } from "../../utils/order";
import { getEventData } from "../../utils/event";
import { hashString } from "../../utils/hash";
import { expectWithinRange } from "../../utils/validation";
import * as keys from "../../utils/keys";
import {
  getPositionCount,
  getAccountPositionCount,
  getPositionKeys,
} from "../../utils/position";
import {
  getBalanceOf,
  getSupplyOf,
  expectTokenBalanceIncrease,
} from "../../utils/token";

import {
  getWithdrawalCount,
  getWithdrawalKeys,
  createWithdrawal,
  executeWithdrawal,
  handleWithdrawal,
} from "../../utils/withdrawal";
import {
  getPoolAmount,
  getMarketTokenPriceWithPoolValue,
} from "../../utils/market";
import { prices } from "../../utils/prices";
import { usingResult } from "../../utils/use";
import {
  OrderType,
  DecreasePositionSwapType,
  getOrderCount,
  getOrderKeys,
  getAccountOrderCount,
  getAccountOrderKeys,
} from "../../utils/order";

describe("Guardian.Lifecycle2", () => {
  let fixture;
  let user0, user1, user2, user3;
  let dataStore,
    exchangeRouter,
    ethUsdMarket,
    ethEthEthMarket,
    referralStorage,
    wnt,
    usdc,
    ethUsdSingleTokenMarket,
    reader;

  const referralCode0 = hashString("example code 0");
  const referralCode1 = hashString("example code 1");
  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0, user1, user2, user3 } = fixture.accounts);
    ({
      dataStore,
      exchangeRouter,
      ethUsdMarket,
      referralStorage,
      wnt,
      usdc,
      ethUsdSingleTokenMarket,
      reader,
    } = fixture.contracts);

    // REFERRAL
    await referralStorage.connect(user2).registerCode(referralCode0);
    await referralStorage.connect(user3).registerCode(referralCode1);

    await referralStorage.setTier(1, 1000, 2000); // tier 1, totalRebate: 10%, discountShare: 20%
    await referralStorage.setTier(2, 2000, 2500); // tier 2, totalRebate: 20%, discountShare: 25%

    await referralStorage.setReferrerTier(user2.address, 1);
    await referralStorage.setReferrerTier(user3.address, 2);
  });

  it("Life cycle test with price fluctuations", async () => {
    // POSITION FEES
    await dataStore.setUint(
      keys.positionFeeFactorKey(ethUsdMarket.marketToken),
      decimalToFloat(5, 4)
    );
    await dataStore.setUint(
      keys.POSITION_FEE_RECEIVER_FACTOR,
      decimalToFloat(2, 1)
    ); // 20%

    // PRICE IMPACT
    await dataStore.setUint(
      keys.positionImpactFactorKey(ethUsdMarket.marketToken, true),
      decimalToFloat(2, 8)
    );
    await dataStore.setUint(
      keys.positionImpactFactorKey(ethUsdMarket.marketToken, false),
      decimalToFloat(1, 8)
    );
    await dataStore.setUint(
      keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken),
      decimalToFloat(2, 0)
    );

    // BORROWING FEES
    await dataStore.setUint(
      keys.borrowingFactorKey(ethUsdMarket.marketToken, true),
      decimalToFloat(1, 7)
    );
    await dataStore.setUint(
      keys.borrowingFactorKey(ethUsdMarket.marketToken, false),
      decimalToFloat(2, 7)
    );
    await dataStore.setUint(
      keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, true),
      decimalToFloat(1)
    );
    await dataStore.setUint(
      keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, false),
      decimalToFloat(1)
    );

    // FUNDING FEES
    await dataStore.setUint(
      keys.fundingFactorKey(ethUsdMarket.marketToken),
      decimalToFloat(1, 10)
    );
    await dataStore.setUint(
      keys.fundingExponentFactorKey(ethUsdMarket.marketToken),
      decimalToFloat(1)
    );

    // KEYS
    await dataStore.setUint(
      keys.POSITION_FEE_RECEIVER_FACTOR,
      decimalToFloat(2, 1)
    ); // 20%
    await dataStore.setUint(
      keys.BORROWING_FEE_RECEIVER_FACTOR,
      decimalToFloat(4, 1)
    ); // 40%

    // #1 Deposit 50.000 long and short
    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(10, 18), // $50.000
        shortTokenAmount: expandDecimals(50 * 1000, 6), // $50.000
      },
    });

    // #1 Market increase 5.000 Collateral 10.000 size
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(10 * 1000), // $10.000
        acceptablePrice: expandDecimals(50036, 11), // 5003.6 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5003, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5003, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5003500350035003"); // ~5003 per token
        },
      },
    });

    // Deposit 50.000 of long token
    await handleDeposit(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(10, 18), // $50.000
      },
    });

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(1);

    // 1 Day later
    await time.increase(24 * 60 * 60); // 1 day

    // Deposit 10.000 of short token
    await handleDeposit(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        shortTokenAmount: expandDecimals(10 * 1000, 6), // $10.000
      },
    });

    // #2 Market increase 1.000 Collateral 2.000 size
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(1000, 6), // $1.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(2 * 1000), // $2.000
        acceptablePrice: expandDecimals(49977, 11), // 4997.7 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4997, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4997, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("4997899621931947"); // ~4998 per token
        },
      },
    });
    // LONGS PAYS SHORTS
    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(2);

    // 5 Hours later
    await time.increase(5 * 60 * 60); // 5 Hours

    // #1 Market decrease 5.000
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(5 * 1000), // $5.000
        acceptablePrice: expandDecimals(49954, 11), // 4995.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4995, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4995, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4995550385038503"); // ~4995 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq(
            "2402802802803"
          ); // 0.0000024028 ETH
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq(
            "2088844490877189"
          ); // 0.0020888 ETH
        },
      },
    });

    // #3 Market increase 3.000 Collateral 15.000 size
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(3 * 1000, 6), // $3.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(15 * 1000), // $15.000
        acceptablePrice: expandDecimals(49998, 11), // 4999.8 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4998, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4998, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("4999049800458096"); // ~4999 per token
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(3);

    // 14 Hours later
    await time.increase(14 * 60 * 60); // 14 Hours

    // #2 Market decrease 5.000
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(5 * 1000), // $5.000
        acceptablePrice: expandDecimals(50064, 11), // 5006.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5005, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5005, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5006551085108510"); // ~50065 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq(
            "4119933553296"
          ); // 0.0000041199 ETH
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq(
            "1006836779756575"
          ); // 0.00100683 ETH
        },
      },
    });

    // 24 Hours later
    await time.increase(24 * 60 * 60); // 24 Hours

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(
      "100000000000000000000000"
    );

    // #1 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        market: ethUsdMarket,
        marketTokenAmount: "50000000000000000000000",
      },
    });
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(
      "50000000000000000000000"
    );

    // #4 Market increase 3.000 Collateral 3.000 size
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(3 * 1000, 6), // $3.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(3 * 1000), // $3.000
        acceptablePrice: expandDecimals(5001, 12), // 5001 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5001150264560848"); // ~5001 per token
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(3);

    // 24 Hours later
    await time.increase(24 * 60 * 60); // 24 Hours

    // #5 Market increase 5.000 Collateral 5.000 size
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5 * 1000, 6), // $5.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(5 * 1000), // $5.000
        acceptablePrice: expandDecimals(50113, 11), // 5011.3 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5010, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5010, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5011252813203300"); // ~5011 per token
        },
      },
    });

    // #3 Market decrease 15.000
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(15 * 1000), // $15.000
        acceptablePrice: expandDecimals(50156, 11), // 5015.6 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5015, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5015, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5015749857470068"); // ~5015 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("225779"); // 0.225779 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("71677471"); // 71.677471 USDC
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(3);

    // 15 Hours later
    await time.increase(15 * 60 * 60); // 15 Hours

    // #6 Market increase 15.000 Collateral 15.000 size
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(15 * 1000, 6), // $15.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(15 * 1000), // $15.000
        acceptablePrice: expandDecimals(50041, 11), // 5004.1 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5005, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5005, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5004249362595610"); // ~5004 per token
        },
      },
    });

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(
      "50000000000000000000000"
    );

    // Deposit 25.000 long and short
    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(5, 18), // $25.000
        shortTokenAmount: expandDecimals(25 * 1000, 6), // $25.000
      },
    });

    // 48 Hours later
    await time.increase(48 * 60 * 60); // 48 Hours
    expect(await getBalanceOf(ethUsdMarket.marketToken, user2.address)).eq(
      "9998655376577946173188"
    );

    // #2 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        marketTokenAmount: "9998655376577946173188",
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(4);

    // #4 Market decrease 2.000
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(2 * 1000), // $2.000
        acceptablePrice: expandDecimals(50487, 11), // 5048.7 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5050, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5050, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5048600588105860"); // ~5048 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("20738"); // 0.020738 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("32041504"); // 32.041504 USDC
        },
      },
    });
    expect(await getPositionCount(dataStore)).to.eq(3);

    // #5 Market decrease 5.000
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(5 * 1000), // $5.000
        acceptablePrice: expandDecimals(49983, 11), // 4998.3 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4998446511627907"); // ~4998 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("1"); // 0.000001 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("6440774"); // 6.440774 USDC
        },
      },
    });
    expect(await getPositionCount(dataStore)).to.eq(2);

    // #6 Market decrease 3.000
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(3 * 1000), // $3.000
        acceptablePrice: expandDecimals(49184, 11), // 4918.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4920, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4920, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4918349620412695"); // ~4918 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("31107"); //  0.031107 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("43559697"); // 43.559697 USDC
        },
      },
    });

    // 48 Hours later
    await time.increase(48 * 60 * 60); // 48 Hours

    expect(await getPositionCount(dataStore)).to.eq(1);

    // #7 Market decrease 15.000
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(15 * 1000), // $15.000
        acceptablePrice: expandDecimals(49993, 11), // 4999.3 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4999251739054541"); // ~4999 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("155534"); // 0.155534 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("291827629"); // 291.827629 USDC
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(0);

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(
      "99983518377295884898977"
    );

    // #3 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        marketTokenAmount: "99983518377295884898977",
      },
    });

    expect(await getBalanceOf(ethUsdMarket.marketToken, user1.address)).eq(
      "49995003257786714378656"
    );

    // #4 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        marketTokenAmount: "49995003257786714378656",
      },
    });

    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(
          ethUsdMarket.marketToken,
          wnt.address,
          user0.address
        )
      )
    ).eq("0");

    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(
          ethUsdMarket.marketToken,
          usdc.address,
          user0.address
        )
      )
    ).eq("0");

    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(
          ethUsdMarket.marketToken,
          wnt.address,
          user2.address
        )
      )
    ).eq("0");

    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(
          ethUsdMarket.marketToken,
          usdc.address,
          user2.address
        )
      )
    ).eq("0");

    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(
          ethUsdMarket.marketToken,
          wnt.address,
          user3.address
        )
      )
    ).eq("0");

    // User1 claims wnt funding fees
    await expectTokenBalanceIncrease({
      token: wnt,
      account: user1,
      sendTxn: async () => {
        await exchangeRouter
          .connect(user1)
          .claimFundingFees(
            [ethUsdMarket.marketToken],
            [wnt.address],
            user1.address
          );
      },
      increaseAmount: "6522736356098",
    });

    // User1 claims usdc funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user1,
      sendTxn: async () => {
        await exchangeRouter
          .connect(user1)
          .claimFundingFees(
            [ethUsdMarket.marketToken],
            [usdc.address],
            user1.address
          );
      },
      increaseAmount: "186895",
    });

    // User3 claims usdc funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user3,
      sendTxn: async () => {
        await exchangeRouter
          .connect(user3)
          .claimFundingFees(
            [ethUsdMarket.marketToken],
            [usdc.address],
            user3.address
          );
      },
      increaseAmount: "246260",
    });

    expect(await getPositionCount(dataStore)).to.eq("0");
    expect(await getOrderCount(dataStore)).to.eq("0");
    expect(await getSupplyOf(ethUsdMarket.marketToken)).eq("0");

    expect(await wnt.balanceOf(user0.address)).eq("17975222779675321954"); // 17.975222779675321954 ETH
    // $89876.11389837660977
    expect(await usdc.balanceOf(user0.address)).eq("77951721546"); // 77951.721546 USDC
    // Total $167827.83544437660977

    expect(await wnt.balanceOf(user1.address)).eq("5856827716086495707"); // 5.856827716086495707 ETH
    // $29284.138580432478535
    expect(await usdc.balanceOf(user1.address)).eq("21734993968"); // 21734.993968 USDC
    // Total $51019.132548432478535

    expect(await wnt.balanceOf(user2.address)).eq("2166311351457971809"); // 2.166311351457971809 ETH
    // $10831.556757289859045
    expect(await usdc.balanceOf(user2.address)).eq("4147959560"); // 4147.959560 USDC
    // Total $14979.516317289859045

    expect(await wnt.balanceOf(user3.address)).eq("0"); // 0 ETH
    // $7674.965377846221395
    expect(await usdc.balanceOf(user3.address)).eq("7979106095"); // 7979.106095 USDC
    // Total $7979.106095
  });

  it("Life cycle test using swap paths and price fluctuations", async () => {
    // POSITION FEES
    await dataStore.setUint(
      keys.positionFeeFactorKey(ethUsdMarket.marketToken),
      decimalToFloat(5, 4)
    );
    await dataStore.setUint(
      keys.POSITION_FEE_RECEIVER_FACTOR,
      decimalToFloat(2, 1)
    ); // 20%

    // PRICE IMPACT
    await dataStore.setUint(
      keys.positionImpactFactorKey(ethUsdMarket.marketToken, true),
      decimalToFloat(2, 8)
    );
    await dataStore.setUint(
      keys.positionImpactFactorKey(ethUsdMarket.marketToken, false),
      decimalToFloat(1, 8)
    );
    await dataStore.setUint(
      keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken),
      decimalToFloat(2, 0)
    );

    // BORROWING FEES
    await dataStore.setUint(
      keys.borrowingFactorKey(ethUsdMarket.marketToken, true),
      decimalToFloat(1, 7)
    );
    await dataStore.setUint(
      keys.borrowingFactorKey(ethUsdMarket.marketToken, false),
      decimalToFloat(2, 7)
    );
    await dataStore.setUint(
      keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, true),
      decimalToFloat(1)
    );
    await dataStore.setUint(
      keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, false),
      decimalToFloat(1)
    );

    // FUNDING FEES
    await dataStore.setUint(
      keys.fundingFactorKey(ethUsdMarket.marketToken),
      decimalToFloat(1, 10)
    );
    await dataStore.setUint(
      keys.fundingExponentFactorKey(ethUsdMarket.marketToken),
      decimalToFloat(1)
    );

    // KEYS
    await dataStore.setUint(
      keys.POSITION_FEE_RECEIVER_FACTOR,
      decimalToFloat(2, 1)
    ); // 20%
    await dataStore.setUint(
      keys.BORROWING_FEE_RECEIVER_FACTOR,
      decimalToFloat(4, 1)
    ); // 40%

    // #1 Deposit 50.000 long and short
    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(10, 18), // $50.000
        shortTokenAmount: expandDecimals(50 * 1000, 6), // $50.000
      },
    });

    // #1 Market increase 5.000 Collateral 10.000 size
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(10 * 1000), // $10.000
        acceptablePrice: expandDecimals(51206, 11), // 5120.6 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5120, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5120, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5120512051205120"); // ~5120 per token
        },
      },
    });

    // Deposit 50.000 of long token
    await handleDeposit(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(10, 18), // $50.000
      },
    });

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(1);

    // 1 Day later
    await time.increase(24 * 60 * 60); // 1 day

    // Deposit 10.000 of short token
    await handleDeposit(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        shortTokenAmount: expandDecimals(10 * 1000, 6), // $10.000
      },
    });

    // #2 Market increase 1.000 Collateral 2.000 size
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(1000, 6), // $1.000
        swapPath: [ethUsdMarket.marketToken],
        sizeDeltaUsd: decimalToFloat(2 * 1000), // $2.000
        acceptablePrice: expandDecimals(49207, 11), // 4920.7 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4920, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4920, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("4920885759436698"); // ~4920 per token
        },
      },
    });

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(2);

    // 5 Hours later
    await time.increase(5 * 60 * 60); // 5 Hours

    // #1 Market decrease 5.000
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(5 * 1000), // $5.000
        acceptablePrice: expandDecimals(49204, 11), // 4920.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4920, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4920, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4920563256325632"); // ~4920 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq(
            "2439430894309"
          ); // 0.0000024394 ETH
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq(
            "2093484925048170"
          ); // 0.0020934 ETH
        },
      },
    });

    // #3 Market increase 3.000 Collateral 15.000 size
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(3 * 1000, 6), // $3.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(15 * 1000), // $15.000
        acceptablePrice: expandDecimals(50911, 11), // 5091.1 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5090, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5090, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5091069124516148"); // ~5091 per token
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(3);

    // 14 Hours later
    await time.increase(14 * 60 * 60); // 14 Hours

    // #2 Market decrease 5.000
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: 0,
        swapPath: [ethUsdMarket.marketToken],
        sizeDeltaUsd: decimalToFloat(5 * 1000), // $5.000
        acceptablePrice: expandDecimals(48214, 11), // 4821.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4820, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4820, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4821587358735873"); // ~4821 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq(
            "4278054100927"
          ); // 0.00000427805 ETH
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq(
            "1033864393845947"
          ); // 0.0010338 ETH
        },
      },
    });

    // 24 Hours later
    await time.increase(24 * 60 * 60); // 24 Hours

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(
      "100000000000000000000000"
    );

    // #1 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        market: ethUsdMarket,
        marketTokenAmount: "50000000000000000000000",
      },
    });

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(
      "50000000000000000000000"
    );

    // #4 Market increase 3.000 Collateral 3.000 size
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(3 * 1000, 6), // $3.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(3 * 1000), // $3.000
        acceptablePrice: expandDecimals(49711, 11), // 5001 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4970, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4970, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("4971143362973483"); // ~4971 per token
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(3);

    // 24 Hours later
    await time.increase(24 * 60 * 60); // 24 Hours

    // #5 Market increase 5.000 Collateral 5.000 size
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5 * 1000, 6), // $5.000
        swapPath: [ethUsdMarket.marketToken],
        sizeDeltaUsd: decimalToFloat(5 * 1000), // $5.000
        acceptablePrice: expandDecimals(52264, 11), // 5226.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5225, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5225, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5226306576644161"); // ~5226 per token
        },
      },
    });

    // #3 Market decrease 15.000
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(15 * 1000), // $15.000
        acceptablePrice: expandDecimals(50255, 11), // 5025.5 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5025, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5025, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5025695912733322"); // ~5025 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("225779"); // 0.225779 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("72284388"); // 72.284388 USDC
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(3);

    // 15 Hours later
    await time.increase(15 * 60 * 60); // 15 Hours

    // #6 Market increase 15.000 Collateral 15.000 size
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(15 * 1000, 6), // $15.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(15 * 1000), // $15.000
        acceptablePrice: expandDecimals(49101, 11), // 4910.1 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4911, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4911, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("4910263460480927"); // ~4910 per token
        },
      },
    });

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(
      "50000000000000000000000"
    );

    // Deposit 25.000 long and short
    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(5, 18), // $25.000
        shortTokenAmount: expandDecimals(25 * 1000, 6), // $25.000
      },
    });

    // 48 Hours later
    await time.increase(48 * 60 * 60); // 48 Hours

    expect(await getBalanceOf(ethUsdMarket.marketToken, user2.address)).eq(
      "9975892365709300827031"
    );

    // #2 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        marketTokenAmount: "9975892365709300827031",
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(4);

    // #4 Market decrease 2.000
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(2 * 1000), // $2.000
        acceptablePrice: expandDecimals(51167, 11), // 5116.7 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5118, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5118, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5116622151987358"); // ~5116 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq(
            "4051864009379"
          ); // 0.000004051 ETH
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq(
            "6030931586422525"
          ); // 0.00603093 ETH
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(3);

    // #5 Market decrease 5.000
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(5 * 1000), // $5.000
        acceptablePrice: expandDecimals(53162, 11), // 5316.2 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5318, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5318, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5316379844961241"); // ~5316 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("179104478"); // 0.000000000179 ETH
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq(
            "1187114960001396"
          ); // 0.0011871 ETH
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(2);

    // #6 Market decrease 3.000
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [ethUsdMarket.marketToken],
        sizeDeltaUsd: decimalToFloat(3 * 1000), // $3.000
        acceptablePrice: expandDecimals(51004, 11), // 5100.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5102, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5102, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5100359522690219"); // ~5100 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("31107"); //  0.031107 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("41527760"); // 41.527760 USDC
        },
      },
    });

    // 48 Hours later
    await time.increase(48 * 60 * 60); // 48 Hours

    expect(await getPositionCount(dataStore)).to.eq(1);

    // #7 Market decrease 15.000
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(15 * 1000), // $15.000
        acceptablePrice: expandDecimals(49045, 11), // 4904.5 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4905, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4905, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4904283622339275"); // ~4904 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("155534"); // 0.155534 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("274640650"); // 274.640650 USDC
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(0);

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(
      "99337358953000964697352"
    );

    // #3 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        marketTokenAmount: "99337358953000964697352",
      },
    });

    expect(await getBalanceOf(ethUsdMarket.marketToken, user1.address)).eq(
      "49881142356701961861288"
    );

    // #4 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        marketTokenAmount: "49881142356701961861288",
      },
    });

    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(
          ethUsdMarket.marketToken,
          wnt.address,
          user0.address
        )
      )
    ).eq("0");

    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(
          ethUsdMarket.marketToken,
          usdc.address,
          user0.address
        )
      )
    ).eq("0");

    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(
          ethUsdMarket.marketToken,
          wnt.address,
          user2.address
        )
      )
    ).eq("0");

    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(
          ethUsdMarket.marketToken,
          usdc.address,
          user2.address
        )
      )
    ).eq("0");

    // User1 claims wnt funding fees
    await expectTokenBalanceIncrease({
      token: wnt,
      account: user1,
      sendTxn: async () => {
        await exchangeRouter
          .connect(user1)
          .claimFundingFees(
            [ethUsdMarket.marketToken],
            [wnt.address],
            user1.address
          );
      },
      increaseAmount: "6717556637026",
    });

    // User1 claims usdc funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user1,
      sendTxn: async () => {
        await exchangeRouter
          .connect(user1)
          .claimFundingFees(
            [ethUsdMarket.marketToken],
            [usdc.address],
            user1.address
          );
      },
      increaseAmount: "186895",
    });

    // User3 claims usdc funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user3,
      sendTxn: async () => {
        await exchangeRouter
          .connect(user3)
          .claimFundingFees(
            [ethUsdMarket.marketToken],
            [usdc.address],
            user3.address
          );
      },
      increaseAmount: "225523",
    });

    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(
          ethUsdMarket.marketToken,
          usdc.address,
          user3.address
        )
      )
    ).eq("0");

    expect(await getPositionCount(dataStore)).to.eq(0);
    expect(await getOrderCount(dataStore)).to.eq(0);

    expect(await getSupplyOf(ethUsdMarket.marketToken)).eq("0");

    expect(await wnt.balanceOf(user0.address)).eq("17574225475836120293"); // 17.574225475836120293 ETH
    // $87871.127379180601465
    expect(await usdc.balanceOf(user0.address)).eq("80454845406"); // 80454.845406 USDC
    // Total $168325.972785180601465

    expect(await wnt.balanceOf(user1.address)).eq("5733082283800865835"); // 5.733082283800865835 ETH
    // $28665.411419004329175
    expect(await usdc.balanceOf(user1.address)).eq("22717760398"); // 22717.760398 USDC
    // Total $51383.171817004329175

    expect(await wnt.balanceOf(user2.address)).eq("1152886839260529288"); // 1.152886839260529288 ETH
    // $5764.43419630264644
    expect(await usdc.balanceOf(user2.address)).eq("8665187552"); // 8665.187552 USDC
    // Total $14429.62174830264644

    expect(await wnt.balanceOf(user3.address)).eq("1534993075569244279"); // 1.534993075569244279 ETH
    // $7674.965377846221395
    expect(await usdc.balanceOf(user3.address)).eq("225523"); // 0.225523 USDC
    // Total $7675.190900846221395
  });

  it("Life cycle test with swaps and price fluctuations", async () => {
    // POSITION FEES
    await dataStore.setUint(
      keys.positionFeeFactorKey(ethUsdMarket.marketToken),
      decimalToFloat(5, 4)
    );
    await dataStore.setUint(
      keys.POSITION_FEE_RECEIVER_FACTOR,
      decimalToFloat(2, 1)
    ); // 20%

    // PRICE IMPACT
    await dataStore.setUint(
      keys.positionImpactFactorKey(ethUsdMarket.marketToken, true),
      decimalToFloat(2, 8)
    );
    await dataStore.setUint(
      keys.positionImpactFactorKey(ethUsdMarket.marketToken, false),
      decimalToFloat(1, 8)
    );
    await dataStore.setUint(
      keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken),
      decimalToFloat(2, 0)
    );

    // BORROWING FEES
    await dataStore.setUint(
      keys.borrowingFactorKey(ethUsdMarket.marketToken, true),
      decimalToFloat(1, 7)
    );
    await dataStore.setUint(
      keys.borrowingFactorKey(ethUsdMarket.marketToken, false),
      decimalToFloat(2, 7)
    );
    await dataStore.setUint(
      keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, true),
      decimalToFloat(1)
    );
    await dataStore.setUint(
      keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, false),
      decimalToFloat(1)
    );

    // FUNDING FEES
    await dataStore.setUint(
      keys.fundingFactorKey(ethUsdMarket.marketToken),
      decimalToFloat(1, 10)
    );
    await dataStore.setUint(
      keys.fundingExponentFactorKey(ethUsdMarket.marketToken),
      decimalToFloat(1)
    );

    // KEYS
    await dataStore.setUint(
      keys.POSITION_FEE_RECEIVER_FACTOR,
      decimalToFloat(2, 1)
    ); // 20%
    await dataStore.setUint(
      keys.BORROWING_FEE_RECEIVER_FACTOR,
      decimalToFloat(4, 1)
    ); // 40%

    // #1 Deposit 50.000 long and short
    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(10, 18), // $50.000
        shortTokenAmount: expandDecimals(50 * 1000, 6), // $50.000
      },
    });

    // #1 Market increase 5.000 Collateral 10.000 size
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(10 * 1000), // $10.000
        acceptablePrice: expandDecimals(49205, 11), // 4920.5 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4920, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4920, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("4920492049204920"); // ~4920 per token
        },
      },
    });

    // Deposit 50.000 of long token
    await handleDeposit(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(10, 18), // $50.000
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(1);

    // 1 Day later
    await time.increase(24 * 60 * 60); // 1 day

    // Deposit 10.000 of short token
    await handleDeposit(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        shortTokenAmount: expandDecimals(10 * 1000, 6), // $10.000
      },
    });

    // #2 Market increase 1.000 Collateral 2.000 size
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(1000, 6), // $1.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(2 * 1000), // $2.000
        acceptablePrice: expandDecimals(51058, 11), // 5105.8 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5105, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5105, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5105919065431777"); // ~5105 per token
        },
      },
    });

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(2);

    // 5 Hours later
    await time.increase(5 * 60 * 60); // 5 Hours

    // #1 Market decrease 5.000
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(5 * 1000), // $5.000
        acceptablePrice: expandDecimals(51204, 11), // 5120.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5120, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5120, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5120541254125412"); // ~5120 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq(
            "2344140625000"
          ); // 0.00000234414 ETH
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq(
            "2072224231944966"
          ); // 0.00207222 ETH
        },
      },
    });

    // #3 Market increase 3.000 Collateral 15.000 size
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(3 * 1000, 6), // $3.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(15 * 1000), // $15.000
        acceptablePrice: expandDecimals(49111, 11), // 4911.1 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4910, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4910, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("4911031316576481"); // ~4911 per token
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(3);

    // 14 Hours later
    await time.increase(14 * 60 * 60); // 14 Hours

    // #2 Market decrease 5.000
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(5 * 1000), // $5.000
        acceptablePrice: expandDecimals(51814, 11), // 5181.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5180, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5180, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5181525352535253"); // ~5181 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq(
            "3980755476428"
          ); // 0.0000039807 ETH
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq(
            "992049844659746"
          ); // 0.0009920 ETH
        },
      },
    });

    // 24 Hours later
    await time.increase(24 * 60 * 60); // 24 Hours

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(
      "100000000000000000000000"
    );

    // #1 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        market: ethUsdMarket,
        marketTokenAmount: "50000000000000000000000",
      },
    });
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(
      "50000000000000000000000"
    );

    // #4 Market increase 3.000 Collateral 3.000 size
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(3 * 1000, 6), // $3.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(3 * 1000), // $3.000
        acceptablePrice: expandDecimals(5031, 12), // 5031 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5030, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5030, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5031157166148214"); // ~5031 per token
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(3);

    // 24 Hours later
    await time.increase(24 * 60 * 60); // 24 Hours

    // #1 Swap 5.000
    await handleOrder(fixture, {
      create: {
        account: user1,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18),
        acceptablePrice: 0,
        orderType: OrderType.MarketSwap,
        swapPath: [ethUsdMarket.marketToken],
      },
    });

    // #5 Market increase 5.000 Collateral 5.000 size
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5 * 1000, 6), // $5.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(5 * 1000), // $5.000
        acceptablePrice: expandDecimals(47762, 11), // 4776.2 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4775, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4775, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("4776194048512128"); // ~4776 per token
        },
      },
    });

    // #3 Market decrease 15.000
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(15 * 1000), // $15.000
        acceptablePrice: expandDecimals(49756, 11), // 4975.6 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4975, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4975, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4975736654697486"); // ~4975 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("225782"); // 0.225782 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("69260518"); // 69.260518 USDC
        },
      },
    });

    // #2 Swap 4.000
    await handleOrder(fixture, {
      create: {
        account: user3,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(4000, 6),
        orderType: OrderType.MarketSwap,
        swapPath: [ethUsdMarket.marketToken],
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(3);

    // 15 Hours later
    await time.increase(15 * 60 * 60); // 15 Hours

    // #6 Market increase 15.000 Collateral 15.000 size
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(15 * 1000, 6), // $15.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(15 * 1000), // $15.000
        acceptablePrice: expandDecimals(50881, 11), // 5088.1 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5089, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5089, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5088236764485327"); // ~5088 per token
        },
      },
    });

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(
      "50000000000000000000000"
    );

    // Deposit 25.000 long and short
    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(5, 18), // $25.000
        shortTokenAmount: expandDecimals(25 * 1000, 6), // $25.000
      },
    });

    // 48 Hours later
    await time.increase(48 * 60 * 60); // 48 Hours
    expect(await getBalanceOf(ethUsdMarket.marketToken, user2.address)).eq(
      "10015526695877083818004"
    );

    // #2 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        marketTokenAmount: "10015526695877083818004",
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(4);

    // #4 Market decrease 2.000
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(2 * 1000), // $2.000
        acceptablePrice: expandDecimals(48806, 11), // 4880.6 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4882, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4882, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4880570342661680"); // ~4880 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("20738"); // 0.020738 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("32515438"); // 32.515438 USDC
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(3);

    // #5 Market decrease 5.000
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(5 * 1000), // $5.000
        acceptablePrice: expandDecimals(46804, 11), // 4680.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4682, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4682, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4680519379844962"); // ~4680 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("1"); // 0.000001 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("6711394"); // 6.711394 USDC
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(2);

    // #6 Market decrease 3.000
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(3 * 1000), // $3.000
        acceptablePrice: expandDecimals(48964, 11), // 4896.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(4898, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(4898, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4896339718135172"); // ~4896 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("31107"); //  0.031107 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("44275888"); // 44.275888 USDC
        },
      },
    });

    // 48 Hours later
    await time.increase(48 * 60 * 60); // 48 Hours

    expect(await getPositionCount(dataStore)).to.eq(1);

    // #7 Market decrease 15.000
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: 0,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(15 * 1000), // $15.000
        acceptablePrice: expandDecimals(50943, 11), // 5094.3 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5095, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5095, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5094236764485328"); // ~5094 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("155534"); // 0.155534 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("296084699"); // 296.084699 USDC
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(0);

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(
      "100437707424868074256254"
    );

    // #3 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        marketTokenAmount: "100437707424868074256254",
      },
    });

    expect(await getBalanceOf(ethUsdMarket.marketToken, user1.address)).eq(
      "50079393916842236616691"
    );

    // #4 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        marketTokenAmount: "50079393916842236616691",
      },
    });
    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(
          ethUsdMarket.marketToken,
          wnt.address,
          user0.address
        )
      )
    ).eq("0");

    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(
          ethUsdMarket.marketToken,
          usdc.address,
          user0.address
        )
      )
    ).eq("0");

    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(
          ethUsdMarket.marketToken,
          wnt.address,
          user2.address
        )
      )
    ).eq("0");

    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(
          ethUsdMarket.marketToken,
          usdc.address,
          user2.address
        )
      )
    ).eq("0");

    expect(
      await dataStore.getUint(
        keys.claimableFundingAmountKey(
          ethUsdMarket.marketToken,
          wnt.address,
          user3.address
        )
      )
    ).eq("0");

    // User1 claims wnt funding fees
    await expectTokenBalanceIncrease({
      token: wnt,
      account: user1,
      sendTxn: async () => {
        await exchangeRouter
          .connect(user1)
          .claimFundingFees(
            [ethUsdMarket.marketToken],
            [wnt.address],
            user1.address
          );
      },
      increaseAmount: "6324896101427",
    });

    // User1 claims usdc funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user1,
      sendTxn: async () => {
        await exchangeRouter
          .connect(user1)
          .claimFundingFees(
            [ethUsdMarket.marketToken],
            [usdc.address],
            user1.address
          );
      },
      increaseAmount: "186897",
    });

    // User3 claims usdc funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user3,
      sendTxn: async () => {
        await exchangeRouter
          .connect(user3)
          .claimFundingFees(
            [ethUsdMarket.marketToken],
            [usdc.address],
            user3.address
          );
      },
      increaseAmount: "246262",
    });

    expect(await getPositionCount(dataStore)).to.eq(0);
    expect(await getOrderCount(dataStore)).to.eq(0);

    expect(await getSupplyOf(ethUsdMarket.marketToken)).eq("0");

    expect(await wnt.balanceOf(user0.address)).eq("18052390210964593828"); // 18.052390210964593828 ETH
    // $90261.95105482296914
    expect(await usdc.balanceOf(user0.address)).eq("77315689729"); // 77315.689729 USDC
    // Total $167577.64078382296914

    expect(await wnt.balanceOf(user1.address)).eq("5886163840415037335"); // 5.886163840415037335 ETH
    // $29430.819202075186675
    expect(await usdc.balanceOf(user1.address)).eq("26508194053"); // 26508.194053 USDC
    // Total $55939.013255075186675

    expect(await wnt.balanceOf(user2.address)).eq("2259790523320679838"); // 2.259790523320679838 ETH
    // $11298.95261660339919
    expect(await usdc.balanceOf(user2.address)).eq("4067005317"); // 4067.005317 USDC
    // Total $15365.95793360339919

    expect(await wnt.balanceOf(user3.address)).eq("800000000000000000"); // 0.8 ETH
    // $4000
    expect(await usdc.balanceOf(user3.address)).eq("7921459544"); // 7921.459544 USDC
    // Total $11921.459544
  });
});
