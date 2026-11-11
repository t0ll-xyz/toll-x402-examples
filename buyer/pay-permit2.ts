/**
 * Pay with "exact" through Permit2 (extra.assetTransferMethod "permit2"), straight to Toll's facilitator.
 * The payer signs one Permit2 transfer for the exact price to the x402ExactPermit2Proxy; the money can only go to payTo.
 * This script plays both sides: it builds the seller's requirement, signs as the payer, then calls /verify and /settle.
 *
 *   npm run permit2 -- 0.01              dry run: sign + /verify. Nothing moves.
 *   SETTLE=1 npm run permit2 -- 0.01     approve Permit2 for exactly the amount if needed (one tx, needs a little ETH), then settle.
 *
 * Pays PAY_TO_FOR_BUYER. Use a throwaway wallet with a few cents.
 */
import { erc20Abi } from "viem";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { SettleError, VerifyError, type PaymentPayload, type PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme, getPermit2AllowanceReadParams } from "@x402/evm/exact/client";
import { FACILITATOR_URL, NETWORK, PERMIT2, SETTLE, USDG, payToFor, payerAccount, publicClient, supportedKind, txLink, u, usdgUnits, walletFor } from "./lib.js";

async function main(): Promise<void> {
  const account = payerAccount();
  const payTo = payToFor(account.address);
  const amount = usdgUnits(process.argv[2] ?? "0.01");

  // 1. Is exact-via-Permit2 on, and is USDG on its token list?
  const kind = await supportedKind("exact");
  const methods = (kind.extra?.assetTransferMethods ?? []) as string[];
  const assets = (kind.extra?.assets ?? []) as { address: string }[];
  if (!methods.includes("permit2")) throw new Error("exact via Permit2 is off on the facilitator right now");
  if (!assets.some((a) => a.address.toLowerCase() === USDG.address.toLowerCase())) throw new Error("USDG is not on the facilitator's Permit2 token list");
  console.log(`exact via Permit2 is on · proxy ${String(kind.extra?.permit2Proxy)}`);

  // 2. The payer must have approved Permit2 for the token (once). Approve exactly the amount, never unlimited.
  const allowance = await publicClient.readContract(getPermit2AllowanceReadParams({ tokenAddress: USDG.address, ownerAddress: account.address }));
  console.log(`payer ${account.address} · Permit2 allowance ${u(allowance)} USDG`);
  if (allowance < amount) {
    if (!SETTLE) {
      console.log(`  the allowance is below ${u(amount)}: /verify will answer permit2_allowance_required. SETTLE=1 sends the approve first.`);
    } else {
      const hash = await walletFor(account).writeContract({ address: USDG.address, abi: erc20Abi, functionName: "approve", args: [PERMIT2, amount] });
      console.log(`  approve Permit2 for ${u(amount)} USDG: ${txLink(hash)}`);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error("the approve reverted");
    }
  }

  // 3. The seller's requirement (what a 402 would carry) and the payer's signature, by the official client.
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: NETWORK,
    asset: USDG.address,
    amount: amount.toString(),
    payTo,
    maxTimeoutSeconds: 300,
    extra: { assetTransferMethod: "permit2" },
  };
  const signed = await new ExactEvmScheme(account).createPaymentPayload(2, requirements);
  const payment: PaymentPayload = { x402Version: 2, accepted: requirements, payload: signed.payload };
  console.log(`signed ${u(amount)} USDG to ${payTo} through Permit2`);

  // 4. Verify, then settle.
  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  try {
    const v = await facilitator.verify(payment, requirements);
    console.log(`/verify: ${v.isValid ? "valid" : `not valid: ${v.invalidReason}`}`);
    if (!v.isValid) { process.exitCode = 1; return; }
  } catch (e) {
    if (e instanceof VerifyError) {
      console.log(`/verify: not valid: ${e.invalidReason} ${e.invalidMessage ?? ""}`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }
  if (!SETTLE) {
    console.log("dry run: nothing moved. Run with SETTLE=1 to settle.");
    return;
  }

  try {
    let s = await facilitator.settle(payment, requirements);
    for (let i = 0; i < 6 && !s.success && s.errorReason === "settlement_pending"; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      s = await facilitator.settle(payment, requirements);
    }
    console.log(s.success ? `settled: ${txLink(s.transaction)}` : `not settled: ${s.errorReason} ${s.errorMessage ?? ""}`);
  } catch (e) {
    if (e instanceof SettleError) console.log(`not settled: ${e.errorReason} ${e.errorMessage ?? ""}`);
    else throw e;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
