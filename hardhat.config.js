require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

module.exports = {
  solidity: {
    compilers: [
      { version: "0.8.19", settings: { optimizer: { enabled: true, runs: 200 } } },
      { version: "0.8.20", settings: { optimizer: { enabled: true, runs: 200 } } }
    ]
  },
  networks: {
    somnia_testnet: {
      url:      "https://api.infra.testnet.somnia.network/",
      chainId:  50312,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : []
    },
    somnia_mainnet: {
      url:      "https://api.infra.mainnet.somnia.network/",
      chainId:  5031,
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : []
    }
  }
};
