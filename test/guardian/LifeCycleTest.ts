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

describe("Guardian.Lifecycle", () => {
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

  it("LIFE CYCLE TEST", async () => {
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
        acceptablePrice: expandDecimals(50006, 11), // 5000.6 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5000500050005000"); // ~5000 per token
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
        acceptablePrice: expandDecimals(50009, 11), // 5000.9 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5000900162029165"); // ~5000 per token
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
        acceptablePrice: expandDecimals(50004, 11), // 5000.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5000550055005500"); // ~5000 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq(
            "2400400000000"
          ); // 0.0000024004 ETH
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq(
            "2088007649694012"
          ); // 0.0020880 ETH
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
        acceptablePrice: expandDecimals(50011, 11), // 5001.1 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5001050220546314"); // ~5001 per token
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
        acceptablePrice: expandDecimals(50004, 11), // 5000.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5001550155015501"); // ~5001 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq(
            "4124053246754"
          ); // 0.000004124053 ETH
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq(
            "1007772937432147"
          ); // 0.00100777 ETH
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
        acceptablePrice: expandDecimals(5001, 11), // 5001 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5001150264560848"); // ~5001 per token
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(3);

    // 24 Hours later
    await time.increase(24 * 60 * 60); // 24 Hours

    // #3 Market increase 5.000 Collateral 5.000 size
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5 * 1000, 6), // $5.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(5 * 1000), // $5.000
        acceptablePrice: expandDecimals(50013, 11), // 5001.3 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5001250312578144"); // ~5001 per token
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
        acceptablePrice: expandDecimals(500005, 10), // 5000.05 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5000750157533081"); // ~5000 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("225779"); // 0.225779 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("71657374"); // 71.657374 USDC
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
        acceptablePrice: expandDecimals(49992, 11), // 4999.2 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("4999250112483127"); // ~4998 per token
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
      "9999254451370059838522"
    );

    // #2 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        marketTokenAmount: "9999254451370059838522",
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
        acceptablePrice: expandDecimals(49986, 11), // 4998.6 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4998599747954632"); // ~4998 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("20738"); // 0.020738 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("32040302"); // 32.040302 USDC
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
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4998449612403101"); // ~4998 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("1"); // 0.000001 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("6450754"); // 6.450754 USDC
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
        acceptablePrice: expandDecimals(49984, 11), // 4998.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4998349620412695"); // ~4998 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("31107"); //  0.031107 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("43557879"); // 43.557879 USDC
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
          expect(positionDecreaseEvent.executionPrice).eq("4999250112483128"); // ~4999 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("155534"); // 0.155534 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("291784435"); // 291.784435 USDC
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(0);

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(
      "99962376511838209303154"
    );

    // #3 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        marketTokenAmount: "99962376511838209303154",
      },
    });

    expect(await getBalanceOf(ethUsdMarket.marketToken, user1.address)).eq(
      "49997999840059193216263"
    );

    // #4 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        marketTokenAmount: "49997999840059193216263",
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
      increaseAmount: "6524453246753",
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

    expect(await getPositionCount(dataStore)).to.eq(0);
    expect(await getOrderCount(dataStore)).to.eq(0);

    expect(await getSupplyOf(ethUsdMarket.marketToken)).eq("0");
  });

  it("LIFE CYCLE TEST USING SWAP PATHS", async () => {
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
        acceptablePrice: expandDecimals(50006, 11), // 5000.6 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5000500050005000"); // ~5000 per token
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
        acceptablePrice: expandDecimals(50009, 11), // 5000.9 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5000900162029165"); // ~5000 per token
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
        acceptablePrice: expandDecimals(50004, 11), // 5000.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5000550055005500"); // ~5000 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq(
            "2400400000000"
          ); // 0.0000024004 ETH
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq(
            "2109080741539804"
          ); // 0.0021090 ETH
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
        acceptablePrice: expandDecimals(50011, 11), // 5001.1 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5001050220546314"); // ~5001 per token
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
        acceptablePrice: expandDecimals(50004, 11), // 5000.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5001550155015501"); // ~5001 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq(
            "4124053246754"
          ); // 0.000004124053 ETH
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq(
            "1017942331581406"
          ); // 0.0010179 ETH
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
        acceptablePrice: expandDecimals(5001, 11), // 5001 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5001150264560848"); // ~5001 per token
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(3);

    // 24 Hours later
    await time.increase(24 * 60 * 60); // 24 Hours

    // #3 Market increase 5.000 Collateral 5.000 size
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5 * 1000, 6), // $5.000
        swapPath: [ethUsdMarket.marketToken],
        sizeDeltaUsd: decimalToFloat(5 * 1000), // $5.000
        acceptablePrice: expandDecimals(50013, 11), // 5001.3 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5001250312578144"); // ~5001 per token
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
        acceptablePrice: expandDecimals(500005, 10), // 5000.05 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5000750157533081"); // ~5000 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("225779"); // 0.225779 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("73737219"); // 73.737219 USDC
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
        acceptablePrice: expandDecimals(49992, 11), // 4999.2 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("4999250112483127"); // ~4999 per token
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
      "9999254451370059838522"
    );

    // #2 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        marketTokenAmount: "9999254451370059838522",
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
        acceptablePrice: expandDecimals(49986, 11), // 4998.6 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4998599747954632"); // ~4998 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq(
            "4147488000000"
          ); // 0.00000414 ETH
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq(
            "6233005122999151"
          ); // 0.0062330 ETH
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
        acceptablePrice: expandDecimals(49983, 11), // 4998.3 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4998449612403101"); // ~4998 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("180000000"); // 0.00000000018 ETH
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq(
            "1321781174149024"
          ); // 0.0013217 ETH
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
        acceptablePrice: expandDecimals(49984, 11), // 4998.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4998349620412695"); // ~4998 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("31107"); //  0.031107 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("41925332"); // 41.925332 USDC
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
          expect(positionDecreaseEvent.executionPrice).eq("4999250112483128"); // ~4999 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("155534"); // 0.155534 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("276888126"); // 276.888126 USDC
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(0);

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(
      "99961911135069028995802"
    );

    // #3 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        marketTokenAmount: "99961911135069028995802",
      },
    });

    expect(await getBalanceOf(ethUsdMarket.marketToken, user1.address)).eq(
      "49997999840059193216263"
    );

    // #4 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        marketTokenAmount: "49997999840059193216263",
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
      increaseAmount: "6524525246753",
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
  });

  it("LIFE CYCLE TEST WITH SWAPS", async () => {
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
        acceptablePrice: expandDecimals(50006, 11), // 5000.6 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5000500050005000"); // ~5000 per token
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
        acceptablePrice: expandDecimals(50009, 11), // 5000.9 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5000900162029165"); // ~5000 per token
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
        acceptablePrice: expandDecimals(50004, 11), // 5000.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5000550055005500"); // ~5000 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq(
            "2400400000000"
          ); // 0.0000024004 ETH
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq(
            "2088007649694012"
          ); // 0.0020880 ETH
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
        acceptablePrice: expandDecimals(50011, 11), // 5001.1 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5001050220546314"); // ~5001 per token
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
        acceptablePrice: expandDecimals(50004, 11), // 5000.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5001550155015501"); // ~5001 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq(
            "4124053246754"
          ); // 0.000004124053 ETH
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq(
            "1007772937432147"
          ); // 0.00100777 ETH
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
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5001150264560848"); // ~5001 per token
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

    // #3 Market increase 5.000 Collateral 5.000 size
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5 * 1000, 6), // $5.000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(5 * 1000), // $5.000
        acceptablePrice: expandDecimals(50013, 11), // 5001.3 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("5001250312578144"); // ~5001 per token
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
        acceptablePrice: expandDecimals(500005, 10), // 5000.05 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("5000750157533081"); // ~5000 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("225782"); // 0.225782 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("67825617"); // 67.825617 USDC
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
        acceptablePrice: expandDecimals(49992, 11), // 4999.2 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionIncreaseEvent = getEventData(logs, "PositionIncrease");
          expect(positionIncreaseEvent.executionPrice).eq("4999250112483127"); // ~4999 per token
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
      "9999254451370059838522"
    );

    // #2 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        marketTokenAmount: "9999254451370059838522",
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
        acceptablePrice: expandDecimals(49986, 11), // 4998.6 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4998599747954632"); // ~4998 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("20738"); // 0.020738 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("32551075"); // 32.551075 USDC
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
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4998449612403101"); // ~4998 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("1"); // 0.000001 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("6382766"); // 6.382766 USDC
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
        acceptablePrice: expandDecimals(49984, 11), // 4998.4 per token
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
      execute: {
        afterExecution: ({ logs }) => {
          const positionDecreaseEvent = getEventData(logs, "PositionDecrease");
          expect(positionDecreaseEvent.executionPrice).eq("4998349620412695"); // ~4998 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("31107"); //  0.031107 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("44324054"); // 44.324054 USDC
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
          expect(positionDecreaseEvent.executionPrice).eq("4999250112483128"); // ~4999 per token

          const positionFeesCollectedEvent = getEventData(
            logs,
            "PositionFeesCollected"
          );
          expect(positionFeesCollectedEvent.fundingFeeAmount).eq("155534"); // 0.155534 USDC
          expect(positionFeesCollectedEvent.borrowingFeeAmount).eq("296259317"); // 296.259317 USDC
        },
      },
    });

    expect(await getPositionCount(dataStore)).to.eq(0);

    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(
      "99963310773094790924599"
    );

    // #3 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        marketTokenAmount: "99963310773094790924599",
      },
    });

    expect(await getBalanceOf(ethUsdMarket.marketToken, user1.address)).eq(
      "49997999840059193216263"
    );

    // #4 Withdraw
    await handleWithdrawal(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        marketTokenAmount: "49997999840059193216263",
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
      increaseAmount: "6524453246753",
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
  });
});
