const hre = require("hardhat");
const fs  = require("fs");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network    = hre.network.name;

  console.log("\n🔱 SOMIPROPHET Treasury Deployment");
  console.log("====================================");
  console.log(`Network:  ${network}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${hre.ethers.formatEther(
    await hre.ethers.provider.getBalance(deployer.address)
  )} ${network.includes("mainnet") ? "SOMI" : "STT"}\n`);

  console.log("💰 Deploying SomiTreasury...");
  const Treasury = await hre.ethers.getContractFactory("SomiTreasury");
  const treasury = await Treasury.deploy();
  await treasury.waitForDeployment();
  const address = await treasury.getAddress();
  console.log(`✅ SomiTreasury deployed: ${address}`);

  // Save to file
  const output = {
    network, deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    SomiTreasury: address,
    nextSteps: [
      `1. Add to .env: TREASURY_CONTRACT=${address}`,
      `2. Deposit SOMI: call deposit() with SOMI value`,
      `3. Approve agent: call approveAgent(YOUR_AGENT_WALLET, true)`,
      `4. Check balance: call getBalance()`
    ]
  };

  fs.mkdirSync("./deployments", { recursive: true });
  const outFile = `./deployments/${network}_treasury.json`;
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

  console.log(`\n📋 NEXT STEPS:`);
  output.nextSteps.forEach(s => console.log(`  ${s}`));
  console.log(`\nSaved to: ${outFile}`);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
