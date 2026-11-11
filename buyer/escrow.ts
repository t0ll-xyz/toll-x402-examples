/**
 * Escrow with refunds (x402 v2 scheme "auth-capture") through Toll's facilitator.
 * The payer's USDG is held in the auth-capture escrow (up to 7 days). The seller captures what it is owed,
 * can refund part of it (paid by the seller), and voids the rest back to the payer. Each seller step is a
 * POST /settle with payload.type, signed by the seller's own key (its receiverAuthorizer).
 *
 *   npm run escrow -- 0.01 0.006                 dry run: the payer signs the hold, /verify only. Nothing moves.
 *   SETTLE=1 npm run escrow -- 0.01 0.006        hold 0.01 -> capture 0.006 -> void the other 0.004
 *   SETTLE=1 npm run escrow -- 0.01 0.006 0.002  ... and refund 0.002 of the capture before the void
 *
 * Needs PAYER_KEY and SELLER_KEY (two throwaway wallets). The seller must be a plain wallet (EOA).
 * The message shapes below are the ones Toll's facilitator settles (see https://x402.t0ll.xyz/docs#escrow).
 */
import { encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, toBytes, decodeFunctionResult, type Address, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { NETWORK, SETTLE, USDG, chainNow, payerAccount, post, publicClient, rand, sellerAccount, settleRaw, signTyped, supportedKind, txLink, u, usdgUnits, type Typed } from "./lib.js";

/** AuthCaptureEscrow v1.0 on Robinhood Chain, its EIP-3009 token collector and the refund collector. */
const ESCROW = "0xbdea0d1bcc5966192b070fdf62ab4ef5b4420cff";
const C3009 = "0x0e3df9510de65469c4518d7843919c0b8c7a7757";
const REFUND_COLLECTOR = "0x934907bffd0901b6a21e398b9c53a4a38f02fa5d";
const ZERO = "0x0000000000000000000000000000000000000000";
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
const OP_TYPES: Record<string, { name: string; type: string }[]> = {
  Capture: [
    { name: "paymentInfoHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "feeBps", type: "uint16" },
    { name: "feeReceiver", type: "address" },
    { name: "expectedCapturableAmount", type: "uint256" },
    { name: "expectedRefundableAmount", type: "uint256" },
  ],
  Void: [{ name: "paymentInfoHash", type: "bytes32" }],
  Refund: [
    { name: "paymentInfoHash", type: "bytes32" },
    { name: "amount", type: "uint256" },
    { name: "tokenCollector", type: "address" },
    { name: "expectedCapturableAmount", type: "uint256" },
    { name: "expectedRefundableAmount", type: "uint256" },
  ],
};
const tokenDomain = { name: USDG.name, version: USDG.version, chainId: 4663, verifyingContract: usdg };
const opDomain = (operator: string) => ({ name: "x402 Auth Capture Operator", version: "1", chainId: 4663, verifyingContract: lc(operator) });

const PI_TYPEHASH = keccak256(toBytes("PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)"));
const SALT_TYPEHASH = keccak256(toBytes("x402AuthCaptureSaltBinding(address receiverAuthorizer,address policy,uint256 saltNonce)"));
const hex32 = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** the salt bound to the seller's receiverAuthorizer */
const boundSalt = (receiverAuthorizer: string, saltNonce: Hex) =>
  BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint256" }], [SALT_TYPEHASH, lc(receiverAuthorizer) as Address, ZERO, BigInt(saltNonce)])));

type PaymentInfo = {
  operator: string; payer: string; receiver: string; token: string; maxAmount: string;
  preApprovalExpiry: number; authorizationExpiry: number; refundExpiry: number;
  minFeeBps: number; maxFeeBps: number; feeReceiver: string; salt: Hex;
};

/** AuthCaptureEscrow.getHash(paymentInfo) with `payer` in the struct (zero = the payer-agnostic signature nonce) */
function hashInfo(pi: PaymentInfo, payer: string): Hex {
  const inner = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint120" }, { type: "uint48" },
      { type: "uint48" }, { type: "uint48" }, { type: "uint16" }, { type: "uint16" }, { type: "address" }, { type: "uint256" }],
    [PI_TYPEHASH, pi.operator as Address, lc(payer) as Address, pi.receiver as Address, pi.token as Address, BigInt(pi.maxAmount), pi.preApprovalExpiry,
      pi.authorizationExpiry, pi.refundExpiry, pi.minFeeBps, pi.maxFeeBps, pi.feeReceiver as Address, BigInt(pi.salt)]));
  return keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }, { type: "bytes32" }], [4663n, ESCROW, inner]));
}

/** the seller's refund funding nonce: keccak256(abi.encodePacked("toll-refund", paymentInfoHash, expectedCapturable, expectedRefundable)) */
const refundFundingNonce = (holdId: Hex, expCap: bigint, expRef: bigint) =>
  keccak256(encodePacked(["string", "bytes32", "uint256", "uint256"], ["toll-refund", holdId, expCap, expRef]));

/** the whole escrow's terms, fixed at the hold (times from the chain's clock) */
function plan(o: { operator: string; payer: string; seller: string; amount: bigint; now: bigint; saltNonce: Hex }) {
  const operator = lc(o.operator), payer = lc(o.payer), seller = lc(o.seller);
  const captureDeadline = Number(o.now + 7200n), refundDeadline = Number(o.now + 86_400n), validBefore = Number(o.now + 900n);
  const extra = { name: USDG.name, version: USDG.version, authCaptureEscrow: ESCROW, captureAuthorizer: operator, receiverAuthorizer: seller,
    paymentFlow: "escrow", captureDeadline, refundDeadline, minFeeBps: 0, maxFeeBps: 0, feeRecipient: ZERO, assetTransferMethod: "eip3009" };
  const pi: PaymentInfo = { operator, payer, receiver: seller, token: usdg, maxAmount: o.amount.toString(), preApprovalExpiry: validBefore,
    authorizationExpiry: captureDeadline, refundExpiry: refundDeadline, minFeeBps: 0, maxFeeBps: 0, feeReceiver: ZERO, salt: hex32(boundSalt(seller, o.saltNonce)) };
  const req = { scheme: "auth-capture", network: NETWORK, asset: usdg, amount: o.amount.toString(), payTo: seller, maxTimeoutSeconds: 300, extra };
  return { operator, payer, seller, amount: o.amount, saltNonce: lc(o.saltNonce), pi, req, holdId: hashInfo(pi, payer), signatureNonce: hashInfo(pi, ZERO) };
}
type Plan = ReturnType<typeof plan>;

const tw = (primaryType: string, fields: { name: string; type: string }[], domain: Record<string, unknown>, message: Record<string, unknown>): Typed =>
  ({ types: { EIP712Domain: DOMAIN_FIELDS, [primaryType]: fields }, primaryType, domain, message });
const opTyped = (p: Plan, primaryType: string, message: Record<string, unknown>) => tw(primaryType, OP_TYPES[primaryType], opDomain(p.operator), message);

/** the payer: ReceiveWithAuthorization to the escrow's EIP-3009 collector for the full hold, nonce = the payer-agnostic hash */
const typedHold = (p: Plan) => tw("ReceiveWithAuthorization", AUTH_FIELDS, tokenDomain,
  { from: p.payer, to: C3009, value: p.amount.toString(), validAfter: "0", validBefore: String(p.pi.preApprovalExpiry), nonce: p.signatureNonce });
/** the seller's receiverAuthorizer: Capture, Void, Refund (domain "x402 Auth Capture Operator" / 1 / 4663 / the operator) */
const typedCapture = (p: Plan, amount: bigint, expCap: bigint, expRef: bigint) => opTyped(p, "Capture", { paymentInfoHash: p.holdId, amount: amount.toString(), feeBps: "0",
  feeReceiver: ZERO, expectedCapturableAmount: expCap.toString(), expectedRefundableAmount: expRef.toString() });
const typedVoid = (p: Plan) => opTyped(p, "Void", { paymentInfoHash: p.holdId });
const typedRefund = (p: Plan, amount: bigint, expCap: bigint, expRef: bigint) => opTyped(p, "Refund", { paymentInfoHash: p.holdId, amount: amount.toString(),
  tokenCollector: REFUND_COLLECTOR, expectedCapturableAmount: expCap.toString(), expectedRefundableAmount: expRef.toString() });
/** the seller as payTo funds a refund: USDG TransferWithAuthorization seller -> operator for exactly the refund */
const typedFunding = (p: Plan, amount: bigint, expCap: bigint, expRef: bigint, validBefore: bigint) => tw("TransferWithAuthorization", AUTH_FIELDS, tokenDomain,
  { from: p.seller, to: p.operator, value: amount.toString(), validAfter: "0", validBefore: validBefore.toString(), nonce: refundFundingNonce(p.holdId, expCap, expRef) });

const wrap = (p: Plan, payload: Record<string, unknown>) => ({ x402Version: 2, paymentPayload: { x402Version: 2, accepted: p.req, payload }, paymentRequirements: p.req });
const holdBody = (p: Plan, signature: Hex) => wrap(p, { authorization: { ...typedHold(p).message }, signature, salt: p.pi.salt, saltNonce: p.saltNonce });
const stepBase = (p: Plan, type: string) => ({ type, paymentInfo: p.pi, saltNonce: p.saltNonce });

const STATE_ABI = [{ type: "function", name: "paymentState", stateMutability: "view", inputs: [{ name: "h", type: "bytes32" }],
  outputs: [{ name: "hasCollectedPayment", type: "bool" }, { name: "capturableAmount", type: "uint120" }, { name: "refundableAmount", type: "uint120" }] }] as const;
async function escrowState(holdId: Hex) {
  const data = await publicClient.call({ to: ESCROW, data: encodeFunctionData({ abi: STATE_ABI, functionName: "paymentState", args: [holdId] }) });
  const [collected, capturable, refundable] = decodeFunctionResult({ abi: STATE_ABI, functionName: "paymentState", data: data.data! });
  return { collected, capturable, refundable };
}

/** a seller step: /verify (dry run on the facilitator), then /settle */
async function step(label: string, body: unknown): Promise<boolean> {
  const v = await post("/verify", body);
  if (!v.isValid) { console.log(`${label}: not valid: ${v.invalidReason} ${v.invalidMessage ?? ""}`); return false; }
  const s = await settleRaw(body);
  if (!s.success) { console.log(`${label}: not settled: ${s.errorReason} ${s.errorMessage ?? ""}`); return false; }
  console.log(`${label}: ${u(s.amount ?? 0)} USDG · status ${s.extensions?.authCapture?.status ?? "-"}${s.transaction ? ` · ${txLink(s.transaction)}` : ""}`);
  await new Promise((r) => setTimeout(r, 2500));
  return true;
}

async function main(): Promise<void> {
  const payer: PrivateKeyAccount = payerAccount();
  const seller: PrivateKeyAccount = sellerAccount();
  if (lc(payer.address) === lc(seller.address)) throw new Error("PAYER_KEY and SELLER_KEY must be two different wallets");
  const hold = usdgUnits(process.argv[2] ?? "0.01", "hold");
  const cap = usdgUnits(process.argv[3] ?? "0.006", "capture");
  const ref = process.argv[4] ? usdgUnits(process.argv[4], "refund") : 0n;
  if (cap <= 0n || cap > hold) throw new Error("the capture must be above 0 and at most the hold");
  if (ref > cap) throw new Error("the refund must be at most the capture");

  const kind = await supportedKind("auth-capture");
  const operator = String(kind.extra?.captureAuthorizer ?? "");
  if (lc(String(kind.extra?.authCaptureEscrow ?? "")) !== ESCROW) throw new Error(`/supported names another escrow (${String(kind.extra?.authCaptureEscrow)}): stop`);
  console.log(`escrow is on · operator ${operator} · escrow ${ESCROW}`);
  if ((await publicClient.getCode({ address: seller.address })) !== undefined) throw new Error("the seller must be a plain wallet (EOA)");

  // 1. HOLD: the payer signs; the facilitator moves the USDG into the escrow.
  const p = plan({ operator, payer: payer.address, seller: seller.address, amount: hold, now: await chainNow(), saltNonce: rand(32) });
  console.log(`hold id (paymentInfoHash) ${p.holdId}: hold ${u(hold)}, capture deadline 2 h, refund deadline 24 h`);
  const body = holdBody(p, await signTyped(payer, typedHold(p)));
  const v = await post("/verify", body);
  console.log(`/verify hold: ${v.isValid ? "valid" : `not valid: ${v.invalidReason} ${v.invalidMessage ?? ""}`}`);
  if (!v.isValid) { process.exitCode = 1; return; }
  if (!SETTLE) { console.log("dry run: nothing moved. Run with SETTLE=1 to hold, capture and void."); return; }
  const s = await settleRaw(body);
  if (!s.success) { console.log(`hold not settled: ${s.errorReason} ${s.errorMessage ?? ""}`); process.exitCode = 1; return; }
  console.log(`held · ${s.transaction ? txLink(s.transaction) : ""}`);
  await new Promise((r) => setTimeout(r, 2500));

  // 2. CAPTURE: the seller signs for what it is owed.
  let st = await escrowState(p.holdId);
  const capBody = wrap(p, { ...stepBase(p, "capture"), amount: cap.toString(), feeBps: 0, feeReceiver: ZERO, expectedCapturableAmount: st.capturable.toString(),
    expectedRefundableAmount: st.refundable.toString(), authorizerSignature: await signTyped(seller, typedCapture(p, cap, st.capturable, st.refundable)) });
  if (!(await step("capture", capBody))) { process.exitCode = 1; return; }

  // 3. REFUND (optional): two seller signatures, the Refund consent and the USDG transfer that funds it.
  if (ref > 0n) {
    st = await escrowState(p.holdId);
    const funding = typedFunding(p, ref, st.capturable, st.refundable, (await chainNow()) + 900n);
    const refBody = wrap(p, { ...stepBase(p, "refund"), amount: ref.toString(), expectedCapturableAmount: st.capturable.toString(), expectedRefundableAmount: st.refundable.toString(),
      authorizerSignature: await signTyped(seller, typedRefund(p, ref, st.capturable, st.refundable)),
      refundFunding: { authorization: { ...funding.message }, signature: await signTyped(seller, funding) } });
    if (!(await step("refund", refBody))) { process.exitCode = 1; return; }
  }

  // 4. VOID: the rest goes back to the payer.
  st = await escrowState(p.holdId);
  if (st.capturable > 0n) {
    const voidBody = wrap(p, { ...stepBase(p, "void"), authorizerSignature: await signTyped(seller, typedVoid(p)) });
    if (!(await step("void", voidBody))) { process.exitCode = 1; return; }
  }
  st = await escrowState(p.holdId);
  console.log(`escrow now: capturable ${u(st.capturable)} · refundable ${u(st.refundable)} (the seller can still refund until the refund deadline)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
