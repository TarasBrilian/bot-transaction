'use strict'
require('dotenv').config()
const { ethers } = require('ethers')
const fs = require('fs')
const path = require('path')

const providerArb = new ethers.JsonRpcProvider(process.env.ARB_RPC_URL)
const providerBase = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL)
const walletArb = new ethers.Wallet(process.env.PRIVATE_KEY, providerArb)
const walletBase = new ethers.Wallet(process.env.PRIVATE_KEY, providerBase)

const ADDR = {
  arb: { vaultManager: '0xA1DE025b706687b9A4ec40A3958aa5dC60BF1B66', mockAave: '0xe8b3d9eC032Cd7fbf3d0f6975384F8FD5f49C0d7', consumer: '0xCCedf582BD0c94c68761A4Ab1Ee5445aA7E29642' },
  base: { vaultManager: '0x5aAe96534Aa5f481A1B92eC8dD48f7A5423b13C4', mockAave: '0xF77216d1f04ADB76c633eb22F2686cF90aC6b0cA', consumer: '0xe3521D9d8b0CF6de832bc23e3ED41b919Ec31647' },
}
const CHAIN_SELECTORS = { arb: 3478487238524512106n, base: 10344971235874465080n }


const STATE_FILE = process.env.STATE_FILE || '/data/.bot-state.json'
const CYCLE_INTERVAL_MS = 3 * 60 * 60 * 1000
const YIELD_TTL_MS = 90 * 60 * 1000
const MIN_SCENARIO_HOLD_MS = 6 * 60 * 60 * 1000
const COOLDOWN_RESET_SECS = 10 * 60

const SCENARIOS_ARB_WINS = [
  { arb: 18, base: 6, winner: 'ARB' },
  { arb: 22, base: 7, winner: 'ARB' },
  { arb: 20, base: 8, winner: 'ARB' },
]
const SCENARIOS_BASE_WINS = [
  { arb: 5, base: 20, winner: 'BASE' },
  { arb: 6, base: 18, winner: 'BASE' },
  { arb: 7, base: 22, winner: 'BASE' },
]


const VAULT_ABI = [
  'function updateYieldData(uint64 chainSelector, uint256 supplyRate)',
  'function resetCooldown()',
  'function setCreOperator(address operator)',
  'function cooldownRemaining() view returns (uint256)',
  'function checkUpkeep(bytes) view returns (bool upkeepNeeded, bytes performData)',
  'function getAllYieldData() view returns (uint64[] chains, uint256[] rates, uint256[] timestamps)',
]
const MOCK_AAVE_ABI = [
  'function setRates(uint256 supplyRate, uint256 borrowRate)',
  'function getSupplyAPY() view returns (uint256)',
]

const vaultArb = new ethers.Contract(ADDR.arb.vaultManager, VAULT_ABI, walletArb)
const vaultBase = new ethers.Contract(ADDR.base.vaultManager, VAULT_ABI, walletBase)
const aaveArb = new ethers.Contract(ADDR.arb.mockAave, MOCK_AAVE_ABI, walletArb)
const aaveBase = new ethers.Contract(ADDR.base.mockAave, MOCK_AAVE_ABI, walletBase)


function loadState() {
  try {
    const dir = path.dirname(STATE_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { lastWinner: 'ARB', lastScenarioMs: 0, cycleCount: 0 }
  }
}

function saveState(state) {
  const dir = path.dirname(STATE_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

const log = (s, m) => console.log(`[${new Date().toISOString().split('T')[1].split('.')[0]}] [${s.padEnd(8)}] ${m}`)
const formatAPY = (r) => `${(Number(r) / 1e16).toFixed(2)}%`
const toWei = (pct) => BigInt(pct) * 10n ** 16n
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const sendTx = async (label, p) => {
  const tx = await p
  log(label, `tx: ${tx.hash}`)
  await tx.wait()
  log(label, 'confirmed ✓')
  return tx.hash
}

function pickScenario(lastWinner) {
  const nextWinner = lastWinner === 'ARB' ? 'BASE' : 'ARB'
  const pool = nextWinner === 'ARB' ? SCENARIOS_ARB_WINS : SCENARIOS_BASE_WINS
  return { ...pool[Math.floor(Math.random() * pool.length)], winner: nextWinner }
}

async function getCooldowns() {
  const [arbR, baseR] = await Promise.all([
    vaultArb.cooldownRemaining(),
    vaultBase.cooldownRemaining(),
  ])
  log('CHECK', `Cooldown — ARB: ${(Number(arbR) / 3600).toFixed(2)}h | BASE: ${(Number(baseR) / 3600).toFixed(2)}h`)
  return { arbR, baseR }
}

async function isYieldDataFresh() {
  try {
    const { timestamps } = await vaultArb.getAllYieldData()
    if (!timestamps || timestamps.length < 2) return false
    const now = Math.floor(Date.now() / 1000)
    const oldest = Math.min(...timestamps.map(Number))
    const ageMs = (now - oldest) * 1000
    log('CHECK', `Yield data age: ${(ageMs / 60000).toFixed(1)} min`)
    return ageMs < YIELD_TTL_MS
  } catch {
    return false
  }
}

async function step1_setRates(scenario) {
  console.log('\n── Step 1: Setting yield rates ──────────────────────────────')
  const arbRate = toWei(scenario.arb)
  const baseRate = toWei(scenario.base)
  log('RATES', `ARB ${scenario.arb}% | BASE ${scenario.base}% | Delta ${Math.abs(scenario.base - scenario.arb)}% → ${scenario.winner} wins`)
  await sendTx('RATES', aaveArb.setRates(arbRate, arbRate))
  await sendTx('RATES', aaveBase.setRates(baseRate, baseRate))
  const [arbAPY, baseAPY] = await Promise.all([aaveArb.getSupplyAPY(), aaveBase.getSupplyAPY()])
  log('RATES', `Verified — ARB: ${formatAPY(arbAPY)} | BASE: ${formatAPY(baseAPY)}`)
  return { arbAPY, baseAPY }
}

async function step2_resetCooldownIfNeeded(arbR, baseR) {
  console.log('\n── Step 2: Checking cooldown ────────────────────────────────')

  if (arbR === 0n) {
    log('COOLDOWN', '[ARB] No cooldown — skip ✓')
  } else if (Number(arbR) <= COOLDOWN_RESET_SECS) {
    log('COOLDOWN', `[ARB] ${(Number(arbR) / 60).toFixed(1)} min remaining — resetting...`)
    await sendTx('COOLDOWN', vaultArb.resetCooldown())
    log('COOLDOWN', '[ARB] reset ✓')
  } else {
    log('COOLDOWN', `[ARB] ${(Number(arbR) / 3600).toFixed(2)}h remaining — skip ✓`)
  }

  if (baseR === 0n) {
    log('COOLDOWN', '[BASE] No cooldown — skip ✓')
  } else if (Number(baseR) <= COOLDOWN_RESET_SECS) {
    log('COOLDOWN', `[BASE] ${(Number(baseR) / 60).toFixed(1)} min remaining — resetting...`)
    await sendTx('COOLDOWN', vaultBase.resetCooldown())
    log('COOLDOWN', '[BASE] reset ✓')
  } else {
    log('COOLDOWN', `[BASE] ${(Number(baseR) / 3600).toFixed(2)}h remaining — skip ✓`)
  }
}

async function step3_updateYieldData(arbAPY, baseAPY) {
  console.log('\n── Step 3: Updating yield data ──────────────────────────────')
  log('YIELD', '[ARB] Setting creOperator → wallet...')
  await sendTx('YIELD', vaultArb.setCreOperator(walletArb.address))
  await sendTx('YIELD', vaultArb.updateYieldData(CHAIN_SELECTORS.arb, arbAPY))
  await sendTx('YIELD', vaultArb.updateYieldData(CHAIN_SELECTORS.base, baseAPY))
  await sendTx('YIELD', vaultArb.setCreOperator(ADDR.arb.consumer))
  log('YIELD', '[ARB] Done ✓')
  log('YIELD', '[BASE] Writing rates (onlyOwner)...')
  await sendTx('YIELD', vaultBase.updateYieldData(CHAIN_SELECTORS.arb, arbAPY))
  await sendTx('YIELD', vaultBase.updateYieldData(CHAIN_SELECTORS.base, baseAPY))
  log('YIELD', '[BASE] Done ✓')
}

async function step4_verify() {
  console.log('\n── Verify: checkUpkeep ──────────────────────────────────────')
  const [[arbReady], [baseReady]] = await Promise.all([
    vaultArb.checkUpkeep('0x'),
    vaultBase.checkUpkeep('0x'),
  ])
  log('VERIFY', `ARB  = ${arbReady ? 'TRUE ✓ Automation will trigger soon' : 'false'}`)
  log('VERIFY', `BASE = ${baseReady ? 'TRUE ✓ Automation will trigger soon' : 'false'}`)
  return { arbReady, baseReady }
}

// ─── Cycle ────────────────────────────────────────────────────────────────────

async function runCycle(state) {
  console.log('\n╔════════════════════════════════════════════════╗')
  console.log(`║  Cycle #${String(state.cycleCount + 1).padEnd(39)}║`)
  console.log('╚════════════════════════════════════════════════╝')
  log('INIT', `Wallet      : ${walletArb.address}`)
  log('INIT', `Last winner : ${state.lastWinner}`)
  log('INIT', `Time        : ${new Date().toISOString()}`)

  const { arbR, baseR } = await getCooldowns()

  const fresh = await isYieldDataFresh()

  if (fresh) {
    const { arbReady, baseReady } = await step4_verify()

    if (arbReady || baseReady) {
      log('CYCLE', 'Yield fresh + checkUpkeep true — waiting for Automation, cycle done')
      return
    }

    log('CYCLE', 'Yield fresh but checkUpkeep false — refreshing rates same direction')
    const pool = state.lastWinner === 'ARB' ? SCENARIOS_ARB_WINS : SCENARIOS_BASE_WINS
    const scenario = pool[Math.floor(Math.random() * pool.length)]
    const { arbAPY, baseAPY } = await step1_setRates(scenario)
    await step2_resetCooldownIfNeeded(arbR, baseR)
    await step3_updateYieldData(arbAPY, baseAPY)
    await step4_verify()
    return
  }

  const scenarioAge = Date.now() - state.lastScenarioMs
  const shouldSwitch = scenarioAge >= MIN_SCENARIO_HOLD_MS || state.lastScenarioMs === 0

  const scenario = shouldSwitch
    ? pickScenario(state.lastWinner)
    : (() => {
      const pool = state.lastWinner === 'ARB' ? SCENARIOS_ARB_WINS : SCENARIOS_BASE_WINS
      return pool[Math.floor(Math.random() * pool.length)]
    })()

  log('CYCLE', shouldSwitch
    ? `Switching scenario → ${scenario.winner} wins`
    : `Same direction — ${scenario.winner} wins (age: ${(scenarioAge / 3600000).toFixed(2)}h)`
  )

  const { arbAPY, baseAPY } = await step1_setRates(scenario)
  await step2_resetCooldownIfNeeded(arbR, baseR)
  await step3_updateYieldData(arbAPY, baseAPY)
  await step4_verify()

  if (shouldSwitch) state.lastWinner = scenario.winner
  state.lastScenarioMs = Date.now()
}

async function main() {
  if (!process.env.PRIVATE_KEY) throw new Error('PRIVATE_KEY not set')
  if (!process.env.ARB_RPC_URL) throw new Error('ARB_RPC_URL not set')
  if (!process.env.BASE_RPC_URL) throw new Error('BASE_RPC_URL not set')

  console.log('\n╔════════════════════════════════════════════════╗')
  console.log('║  CrossYield Bot — Cycle Mode (3h interval)     ║')
  console.log('╚════════════════════════════════════════════════╝')
  log('INIT', `Cycle interval : 3 hours`)
  log('INIT', `State file     : ${STATE_FILE}`)

  while (true) {
    const state = loadState()

    try {
      await runCycle(state)
    } catch (err) {
      log('ERROR', `Cycle failed: ${err.message}`)
    }

    state.cycleCount++
    saveState(state)

    const nextRun = new Date(Date.now() + CYCLE_INTERVAL_MS)
    log('SLEEP', `Next cycle at ${nextRun.toISOString()} (in 3 hours)`)
    console.log()

    await sleep(CYCLE_INTERVAL_MS)
  }
}

main().catch(err => {
  console.error('\n[FATAL]', err.message)
  process.exit(1)
})