/**
 * Sub-cent payments (x402 v2 scheme "batch-settlement", facilitator-managed vouchers) through Toll's facilitator.
 * The payer deposits USDG into a channel once, then signs a running total (a voucher) per request: no transaction,
 * no gas per request. Toll's facilitator claims many channels in one transaction later. What is not charged goes
 * back to the payer: by a refund the seller signs, or by the payer's own withdrawal after a 1-day delay.
 *
 *   npm run batch -- 0.01 0.001 3              dry run: sign the deposit + voucher 1, /verify only. Nothing moves.
 *   SETTLE=1 npm run batch -- 0.01 0.001 3     deposit 0.01, then 3 vouchers of 0.001 (0.003 charged in total)
 *   SETTLE=1 npm run batch -- refund           later, once the claim landed: the seller gives the payer back the rest
 *
 * Pays PAY_TO_FOR_BUYER. The refund step needs SELLER_KEY (the wallet of PAY_TO_FOR_BUYER). Throwaway wallets only.
 * The channel is saved to .batch-channel.json (git-ignored) so the refund can run later.
 * The message shapes below are the ones Toll's facilitator settles (see https://x402.t0ll.xyz/docs#batch).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, hashTypedData, keccak256, type Address, type Hex } from "viem";
import { NETWORK, SETTLE, USDG, chainNow, payToFor, payerAccount, post, publicClient, rand, sellerAccount, signTyped, supportedKind, txLink, u, usdgUnits, type Typed } from "./lib.js";

/** x402BatchSettlement and its EIP-3009 deposit collector on Robinhood Chain */
const SETTLEMENT = "0x4020074e9df2ce1dee5a9c1b5c3f541d02a10003";
const COLLECTOR = "0x4020806089470a89826cb9fb1f4059150b550004";
const WITHDRAW_DELAY = 86400;
const STATE_FILE = ".batch-channel.json";
const usdg = USDG.address.toLowerCase();
const lc = (s: string) => s.toLowerCase();

const DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];
const AUTH_FIELDS = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];
const CONFIG_FIELDS = [
  { name: "payer", type: "address" },
  { name: "payerAuthorizer", type: "address" },
  { name: "receiver", type: "address" },
  { name: "receiverAuthorizer", type: "address" },
  { name: "token", type: "address" },
  { name: "withdrawDelay", type: "uint40" },
  { name: "salt", type: "bytes32" },
];
const VOUCHER_FIELDS = [
  { name: "channelId", type: "bytes32" },
  { name: "maxClaimableAmount", type: "uint128" },
];
const REFUND_FIELDS = [
  { name: "channelId", type: "bytes32" },
  { name: "nonce", type: "uint256" },
  { name: "amount", type: "uint128" },
];
const batchDomain = { name: "x402 Batch Settlement", version: "1", chainId: 4663, verifyingContract: SETTLEMENT };
const tokenDomain = { name: USDG.name, version: USDG.version, chainId: 4663, verifyingContract: usdg };

type Config = { payer: string; payerAuthorizer: string; receiver: string; receiverAuthorizer: string; token: string; withdrawDelay: number; salt: string };

/** a facilitator-managed salt: 12 bytes of entropy, then the seller's refundAuthorizer (its 20 bytes) */
const saltOf = (entropy12: Hex, refundAuthorizer: string) => lc(`0x${entropy12.replace(/^0x/, "").padStart(24, "0")}${lc(refundAuthorizer).slice(2)}`);
const configOf = (o: { payer: string; seller: string; authorizer: string; salt: string }): Config => ({ payer: lc(o.payer), payerAuthorizer: lc(o.payer),
  receiver: lc(o.seller), receiverAuthorizer: lc(o.authorizer), token: usdg, withdrawDelay: WITHDRAW_DELAY, salt: lc(o.salt) });
/** x402BatchSettlement.getChannelId(config): the EIP-712 hash of the config under the contract's domain */
const channelIdOf = (c: Config) => hashTypedData({ domain: { ...batchDomain, verifyingContract: SETTLEMENT as Address }, types: { ChannelConfig: CONFIG_FIELDS },
  primaryType: "ChannelConfig", message: { ...c, withdrawDelay: BigInt(c.withdrawDelay) } as Record<string, unknown> });
/** the deposit collector's EIP-3009 nonce: keccak256(abi.encode(channelId, salt)) */
const depositNonceOf = (channelId: Hex, salt: bigint) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [channelId, salt]));

const tw = (primaryType: string, fields: { name: string; type: string }[], domain: Record<string, unknown>, message: Record<string, unknown>): Typed =>
  ({ types: { EIP712Domain: DOMAIN_FIELDS, [primaryType]: fields }, primaryType, domain, message });
const typedDeposit = (c: Config, channelId: Hex, amount: bigint, validBefore: bigint, salt: bigint) => tw("ReceiveWithAuthorization", AUTH_FIELDS, tokenDomain,
  { from: c.payer, to: COLLECTOR, value: amount.toString(), validAfter: "0", validBefore: validBefore.toString(), nonce: depositNonceOf(channelId, salt) });
/** a cumulative voucher: the total the seller may claim from this channel so far */
const typedVoucher = (channelId: Hex, max: bigint) => tw("Voucher", VOUCHER_FIELDS, batchDomain, { channelId, maxClaimableAmount: max.toString() });
/** the seller's refundAuthorizer consents to give `amount` back (the channel's current refund nonce) */
const typedRefund = (channelId: Hex, nonce: bigint, amount: bigint) => tw("Refund", REFUND_FIELDS, batchDomain, { channelId, nonce: nonce.toString(), amount: amount.toString() });

const extraOf = (authorizer: string, refundAuthorizer: string) => ({ name: USDG.name, version: USDG.version, receiverAuthorizer: lc(authorizer), withdrawDelay: WITHDRAW_DELAY,
  voucherManager: "facilitator", refundAuthorizer: lc(refundAuthorizer), assetTransferMethod: "eip3009" });
const reqOf = (amount: bigint, payTo: string, extra: Record<string, unknown>) => ({ scheme: "batch-settlement", network: NETWORK, asset: usdg, amount: amount.toString(),
  payTo: lc(payTo), maxTimeoutSeconds: 300, extra });

type BodyOpts = {
  type: "deposit" | "voucher" | "refund"; config: Config; channelId: Hex; max: bigint; voucherSig: Hex; price: bigint; extra: Record<string, unknown>;
  pendingId?: string; deposit?: { amount: bigint; validBefore: bigint; salt: bigint; signature: Hex }; refund?: { amount: bigint; nonce: bigint; signature: Hex };
};
/** one /verify or /settle body; accepted.amount = paymentRequirements.amount = the price of this request */
function bodyOf(o: BodyOpts) {
  const payload: Record<string, unknown> = { type: o.type, channelConfig: { ...o.config }, voucher: { channelId: o.channelId, maxClaimableAmount: o.max.toString(), signature: o.voucherSig } };
  if (o.deposit) payload.deposit = { amount: o.deposit.amount.toString(), authorization: { erc3009Authorization: { validAfter: "0",
    validBefore: o.deposit.validBefore.toString(), salt: `0x${o.deposit.salt.toString(16).padStart(64, "0")}`, signature: o.deposit.signature } } };
  if (o.refund) { payload.amount = o.refund.amount.toString(); payload.refundNonce = o.refund.nonce.toString(); payload.refundAuthorizerSignature = o.refund.signature; }
  if (o.pendingId) payload.pendingId = o.pendingId;
  const req = reqOf(o.price, o.config.receiver, o.extra);
  return { x402Version: 2, paymentPayload: { x402Version: 2, accepted: req, payload }, paymentRequirements: req };
}

const READ_ABI = [
  { type: "function", name: "channels", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ name: "balance", type: "uint128" }, { name: "totalClaimed", type: "uint128" }] },
  { type: "function", name: "refundNonce", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ type: "uint256" }] },
] as const;
async function channel(channelId: Hex) {
  const r = await publicClient.call({ to: SETTLEMENT, data: encodeFunctionData({ abi: READ_ABI, functionName: "channels", args: [channelId] }) });
  const [balance, claimed] = decodeFunctionResult({ abi: READ_ABI, functionName: "channels", data: r.data! });
  return { balance, claimed };
}
async function refundNonce(channelId: Hex) {
  const r = await publicClient.call({ to: SETTLEMENT, data: encodeFunctionData({ abi: READ_ABI, functionName: "refundNonce", args: [channelId] }) });
  return decodeFunctionResult({ abi: READ_ABI, functionName: "refundNonce", data: r.data! });
}

/** /verify reserves the channel and returns a pendingId; /settle echoes it, as a resource server does */
async function verifyThenSettle(o: BodyOpts, settle: boolean): Promise<Record<string, any> | null> {
  const v = await post("/verify", bodyOf(o));
  if (!v.isValid) { console.log(`  /verify: not valid: ${v.invalidReason} ${v.invalidMessage ?? ""}`); return null; }
  console.log(`  /verify: valid · channel balance ${u(v.extra?.balance ?? 0)} · charged so far ${u(v.extra?.chargedCumulativeAmount ?? 0)}`);
  if (!settle) return v;
  const s = await post("/settle", bodyOf({ ...o, pendingId: v.extra?.pendingId }));
  if (!s.success) { console.log(`  /settle: not settled: ${s.errorReason} ${s.errorMessage ?? ""}`); return null; }
  return s;
}

type Saved = { config: Config; channelId: Hex; authorizer: string; price: string; lastMax: string; lastSig: Hex };

async function main(): Promise<void> {
  if (process.argv[2] === "refund") return refund();

  const payer = payerAccount();
  const seller = payToFor(payer.address);
  const deposit = usdgUnits(process.argv[2] ?? "0.01", "deposit");
  const price = BigInt(Math.round(Number(process.argv[3] ?? "0.001") * 1e6));
  const count = Number(process.argv[4] ?? "3");
  if (price <= 0n || !Number.isInteger(count) || count < 1 || price * BigInt(count) > deposit) throw new Error("price x count must fit in the deposit");

  const kind = await supportedKind("batch-settlement");
  const authorizer = String(kind.extra?.receiverAuthorizer ?? "");
  if (Number(kind.extra?.withdrawDelay) !== WITHDRAW_DELAY) throw new Error(`/supported says withdrawDelay ${String(kind.extra?.withdrawDelay)}, this script builds ${WITHDRAW_DELAY}`);
  console.log(`batch is on · receiverAuthorizer ${authorizer} · settlement ${SETTLEMENT}`);

  // A new channel: receiver = the seller, refundAuthorizer (inside the salt) = the seller.
  const config = configOf({ payer: payer.address, seller, authorizer, salt: saltOf(rand(12), seller) });
  const channelId = channelIdOf(config);
  const extra = extraOf(authorizer, seller);
  console.log(`channel ${channelId}: deposit ${u(deposit)}, then ${count} vouchers of ${u(price)}`);

  // 1. DEPOSIT + voucher 1 (two payer signatures, one transaction by the facilitator).
  const validBefore = (await chainNow()) + 600n, salt = BigInt(rand(32));
  const depositSig = await signTyped(payer, typedDeposit(config, channelId, deposit, validBefore, salt));
  let max = price;
  let voucherSig = await signTyped(payer, typedVoucher(channelId, max));
  const base = { config, channelId, price, extra };
  const first = await verifyThenSettle({ ...base, type: "deposit", max, voucherSig, deposit: { amount: deposit, validBefore, salt, signature: depositSig } }, SETTLE);
  if (!first) { process.exitCode = 1; return; }
  if (!SETTLE) { console.log("dry run: nothing moved. Run with SETTLE=1 to deposit and pay."); return; }
  console.log(`  deposited${first.transaction ? ` · ${txLink(first.transaction)}` : ""} · voucher 1 charged ${u(first.extra?.chargedAmount ?? 0)}`);

  // 2. More vouchers: one signature each, no transaction, no gas.
  for (let n = 2; n <= count; n++) {
    max = price * BigInt(n);
    voucherSig = await signTyped(payer, typedVoucher(channelId, max));
    const s = await verifyThenSettle({ ...base, type: "voucher", max, voucherSig }, true);
    if (!s) { process.exitCode = 1; return; }
    console.log(`  voucher ${n}: charged total ${u(s.extra?.channelState?.chargedCumulativeAmount ?? 0)} · transaction "${s.transaction ?? ""}" (none per request)`);
  }

  const saved: Saved = { config, channelId, authorizer, price: price.toString(), lastMax: max.toString(), lastSig: voucherSig };
  writeFileSync(STATE_FILE, JSON.stringify(saved, null, 2));
  console.log(`charged ${u(max)} USDG in total. The facilitator claims it on chain later (in one batch).`);
  console.log(`saved the channel to ${STATE_FILE}. Once the claim landed, the seller can give the rest back: SETTLE=1 npm run batch -- refund`);
}

async function refund(): Promise<void> {
  if (!existsSync(STATE_FILE)) throw new Error(`no ${STATE_FILE}: run a batch first`);
  const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Saved;
  const seller = sellerAccount();
  if (lc(seller.address) !== s.config.receiver) throw new Error(`SELLER_KEY is not the channel's seller ${s.config.receiver}`);
  const ch = await channel(s.channelId);
  const left = ch.balance - ch.claimed;
  console.log(`channel ${s.channelId}: balance ${u(ch.balance)} · claimed ${u(ch.claimed)} · left ${u(left)}`);
  if (ch.claimed !== BigInt(s.lastMax)) { console.log("the claim has not landed in full yet: try again later"); return; }
  if (left <= 0n) { console.log("nothing left to give back"); return; }
  const nonce = await refundNonce(s.channelId);
  const signature = await signTyped(seller, typedRefund(s.channelId, nonce, left));
  const body: BodyOpts = { type: "refund", config: s.config, channelId: s.channelId, max: BigInt(s.lastMax), voucherSig: s.lastSig, price: BigInt(s.price),
    extra: extraOf(s.authorizer, s.config.receiver), refund: { amount: left, nonce, signature } };
  const r = await verifyThenSettle(body, SETTLE);
  if (!r) { process.exitCode = 1; return; }
  if (!SETTLE) { console.log("dry run: nothing moved. Run with SETTLE=1 to refund."); return; }
  console.log(`refunded ${u(r.amount ?? 0)} USDG to the payer${r.transaction ? ` · ${txLink(r.transaction)}` : ""}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
