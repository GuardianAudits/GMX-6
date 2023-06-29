import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import * as keys from "../../utils/keys";
import {getBalanceOf} from "../../utils/token";


describe("Guardian.EDU-1", () => {
    let fixture;
    let wallet, user0, user1, user2;
    let roleStore, dataStore, wnt, usdc, reader, referralStorage, ethUsdSingleTokenMarket;

    beforeEach(async () => {
        fixture = await deployFixture();
        ({wallet, user0, user1, user2} = fixture.accounts);
        ({roleStore, dataStore, wnt, usdc, reader, referralStorage, ethUsdSingleTokenMarket} = fixture.contracts);

        await handleDeposit(fixture, {
            create: {
                account: user0,
                market: ethUsdSingleTokenMarket,
                longTokenAmount: expandDecimals(1000 * 1000, 6), // Initially there is $1,000,000 of USDC into the market
            },
            execute: {
                precisions: [8, 18],
                tokens: [wnt.address, usdc.address],
                minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
                maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
            }
        });
    });

    it("Invalid price impact while depositing into homogenous markets", async () => {
        // Activate price impact
        // set price impact to 0.1% for every $100,000 of token imbalance
        // 0.1% => 0.001
        // 0.001 / 100,000 => 1 * (10 ** -8)
        await dataStore.setUint(keys.swapImpactFactorKey(ethUsdSingleTokenMarket.marketToken, true), decimalToFloat(1, 8));
        await dataStore.setUint(keys.swapImpactFactorKey(ethUsdSingleTokenMarket.marketToken, false), decimalToFloat(1, 8));
        await dataStore.setUint(keys.swapImpactExponentFactorKey(ethUsdSingleTokenMarket.marketToken), decimalToFloat(2, 0));

        await handleDeposit(fixture, {
            create: {
                account: user1,
                market: ethUsdSingleTokenMarket,
                longTokenAmount: expandDecimals(1000 * 100, 6), // Deposit $100,000 of USDC into the market
            },
            execute: {
                precisions: [8, 18],
                tokens: [wnt.address, usdc.address],
                minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
                maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
            }
        });

        const user1MarketTokensAmount = await getBalanceOf(ethUsdSingleTokenMarket.marketToken, user1.address);
        await expect(user1MarketTokensAmount).to.eq(expandDecimals(99_900, 18));

        // Now turn off price impact and observe the difference
        await dataStore.setUint(keys.swapImpactFactorKey(ethUsdSingleTokenMarket.marketToken, true), 0);
        await dataStore.setUint(keys.swapImpactFactorKey(ethUsdSingleTokenMarket.marketToken, false), 0);
        await dataStore.setUint(keys.swapImpactExponentFactorKey(ethUsdSingleTokenMarket.marketToken), 0);

        await handleDeposit(fixture, {
            create: {
                account: user2,
                market: ethUsdSingleTokenMarket,
                longTokenAmount: expandDecimals(1000 * 100, 6), // Deposit $100,000 of USDC into the market
            },
            execute: {
                precisions: [8, 18],
                tokens: [wnt.address, usdc.address],
                minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
                maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
            }
        });

        // User 2 receives 100,000 Market tokens when price impact is deactivated.
        // However, there should never be price impact for homogenous markets as:
        //      1. They are never used for swaps.
        //      2. Their backing tokens balance is always "balanced" because it is simply divided by 2 for each side.
        const user2MarketTokensAmount = await getBalanceOf(ethUsdSingleTokenMarket.marketToken, user2.address);
        await expect(user2MarketTokensAmount).to.eq(expandDecimals(100_000, 18));
    });


});