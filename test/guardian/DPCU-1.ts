import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import * as keys from "../../utils/keys";
import {handleOrder, OrderType} from "../../utils/order";
import {time} from "@nomicfoundation/hardhat-network-helpers";
import {getEventData} from "../../utils/event";
import {expectWithinRange} from "../../utils/validation";
import {getPositionCount, getPositionKeys} from "../../utils/position";
import {prices} from "../../utils/prices";


describe("Guardian.DPCU-1", () => {
    let fixture;
    let wallet, user0, user1, user2;
    let roleStore, dataStore, wnt, usdc, reader, referralStorage, ethUsdMarket;

    beforeEach(async () => {
        fixture = await deployFixture();
        ({wallet, user0, user1, user2} = fixture.accounts);
        ({roleStore, dataStore, wnt, usdc, reader, referralStorage, ethUsdMarket} = fixture.contracts);

        await handleDeposit(fixture, {
            create: {
                account: user0,
                market: ethUsdMarket,
                longTokenAmount: expandDecimals(100, 18),
                shortTokenAmount: expandDecimals(100 * 5000, 6),
            },
            execute: {
                precisions: [8, 18],
                tokens: [wnt.address, usdc.address],
                minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
                maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
            }
        });
    });

    it.only("CRITICAL: latestFundingFeeAmountPerSize reset for a position", async () => {
        // Activate funding fees
        await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(5, 10));
        await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1));

        await dataStore.setAddress(keys.HOLDING_ADDRESS, user2.address);

        expect(await dataStore.getUint(keys.fundingUpdatedAtKey(ethUsdMarket.marketToken))).eq(0);

        // Activate borrowing fees to get big fees
        await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 7));
        await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 7));
        await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1));
        await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1));
        
        // ORDER 1
        // user0 opens a $200k long position, using wnt as collateral
        await handleOrder(fixture, {
            create: {
                account: user0,
                market: ethUsdMarket,
                initialCollateralToken: usdc,
                initialCollateralDeltaAmount: expandDecimals(2_500, 6),
                swapPath: [],
                sizeDeltaUsd: decimalToFloat(200 * 1000),
                acceptablePrice: expandDecimals(5050, 12),
                executionFee: expandDecimals(1, 15),
                minOutputAmount: 0,
                orderType: OrderType.MarketIncrease,
                isLong: true,
                shouldUnwrapNativeToken: false,
            },
        });

        // ORDER 2
        // user1 opens a $100k short position, using usdc as collateral
        await handleOrder(fixture, {
            create: {
                account: user1,
                market: ethUsdMarket,
                initialCollateralToken: usdc,
                initialCollateralDeltaAmount: expandDecimals(10 * 1000, 6),
                swapPath: [],
                sizeDeltaUsd: decimalToFloat(100 * 1000),
                acceptablePrice: expandDecimals(4950, 12),
                executionFee: expandDecimals(1, 15),
                minOutputAmount: 0,
                orderType: OrderType.MarketIncrease,
                isLong: false,
                shouldUnwrapNativeToken: false,
            },
        });

        // Some funding fees accumulate
        await time.increase(14 * 24 * 60 * 60);

        // Longs pay shorts, user0 has funding fees to pay
        // Decrease position size by 50%,
        // fees are more than my collateral, secondary token pays for fees and my position is left over
        await handleOrder(fixture, {
            create: {
                account: user0,
                market: ethUsdMarket,
                initialCollateralToken: usdc,
                swapPath: [],
                sizeDeltaUsd: decimalToFloat(100 * 1000),
                acceptablePrice: expandDecimals(7950, 12),
                executionFee: expandDecimals(1, 15),
                minOutputAmount: 0,
                orderType: OrderType.MarketDecrease,
                isLong: true,
                shouldUnwrapNativeToken: false,
            },
            execute: {
                precisions: [8, 18],
                tokens: [wnt.address, usdc.address],
                minPrices: [expandDecimals(8000, 4), expandDecimals(1, 6)],
                maxPrices: [expandDecimals(8000, 4), expandDecimals(1, 6)],
                afterExecution: ({ logs }) => {
                    const positionFeesCollectedEvent = getEventData(logs, "PositionFeesCollected");
                    // Event emits with zero funding fees paid, however I did indeed pay them, and entirely in the collateral token
                    expect(positionFeesCollectedEvent.fundingFeeAmount).to.be.eq("0");
                },
            },
        });

        let positionKeys = await getPositionKeys(dataStore, 0, 10);
        const position0 = await reader.getPosition(dataStore.address, positionKeys[0]);

        expect(await getPositionCount(dataStore)).to.eq(2);
        expect(position0.addresses.account).to.eq(user0.address);

        // The funding amount per size has been reset for user0, they will have to pay all the
        // funding fees that have ever accumulated, even before they entered the market now.
        // This will likely make any position liquidatable unexpectedly and cause a significant loss of assets
        expect(position0.numbers.fundingFeeAmountPerSize).to.eq(0);

        const position0Info = await reader.getPositionInfo(
            dataStore.address,
            referralStorage.address,
            positionKeys[0],
            prices.ethUsdMarket.increased,
            0, // sizeDeltaUsd
            ethers.constants.AddressZero,
            true // usePositionSizeAsSizeDeltaUsd
        );

        // user0 has to pay all funding fees in the market up to this point per their size.
        expect(position0Info.fees.funding.fundingFeeAmount).to.eq("20160050");

    });
});