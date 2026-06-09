const hre = require("hardhat");
const fs  = require("fs");

const PLATFORM_TESTNET = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network    = hre.network.name;

  console.log("\n🔱 SOMIPROPHET — Onchain Agent Deployment");
  console.log("==========================================");
  console.log(`Network:  ${network}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address))} ${network.includes("mainnet") ? "SOMI" : "STT"}\n`);

  console.log("🤖 Deploying SomiProphetAgent...");
  const Agent = await hre.ethers.getContractFactory("SomiProphetAgent");
  const agent = await Agent.deploy(PLATFORM_TESTNET);
  await agent.waitForDeployment();
  const address = await agent.getAddress();
  console.log(`✅ SomiProphetAgent deployed: ${address}`);

  const out = {
    network, deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    SomiProphetAgent: address,
    platform: PLATFORM_TESTNET,
    nextSteps: [
      `1. Add to .env: SOMNIA_AGENT_CONTRACT=${address}`,
      `2. Add to .env: AGENT_CALLER_KEY=<key of an STT-funded wallet>`,
      `3. Set the LLM agent ID: call setLlmAgentId() with the ID from`,
      `   https://agents.testnet.somnia.network/`,
      `4. Fund this contract with STT for agent calls`,
      `5. Restart backend — bridge auto-connects`
    ]
  };
  fs.mkdirSync("./deployments", { recursive: true });
  fs.writeFileSync(`./deployments/${network}_agent.json`, JSON.stringify(out, null, 2));

  console.log("\n📋 NEXT STEPS:");
  out.nextSteps.forEach(s => console.log("  " + s));
}

main().catch(e => { console.error(e); process.exitCode = 1; });
