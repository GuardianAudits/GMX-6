import { grantRoleIfNotGranted } from "../utils/role";
import { createDeployFunction } from "../utils/deploy";

const constructorContracts = [
  "RoleStore",
  "DataStore",
  "EventEmitter",
  "OrderVault",
  "Oracle",
  "SwapHandler",
  "ReferralStorage",
];

const func = createDeployFunction({
  contractName: "AdlHandler",
  dependencyNames: constructorContracts,
  getDeployArgs: async ({ dependencyContracts }) => {
    return constructorContracts.map((dependencyName) => dependencyContracts[dependencyName].address);
  },
  libraryNames: ["GasUtils", "OrderUtils", "AdlUtils", "MarketStoreUtils", "PositionStoreUtils", "OrderStoreUtils"],
  afterDeploy: async ({ deployedContract }) => {
    await grantRoleIfNotGranted(deployedContract.address, "CONTROLLER");
  },
});

export default func;
