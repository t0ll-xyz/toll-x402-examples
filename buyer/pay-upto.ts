/**
 * Pay with "upto": the payer signs a maximum through Permit2, the seller settles only what it used.
 * Settling 0 sends no transaction. This script plays both sides against Toll's facilitator.
 *
 *   npm run upto -- 0.01 0.004           dry run: sign a 0.01 maximum + /verify. Nothing moves.
 *   SETTLE=1 npm run upto -- 0.01 0.004  approve Permit2 for exactly the maximum if needed (one tx), then settle 0.004.
 *
 * Pays PAY_TO_FOR_BUYER. Use a throwaway wallet with a few cents.
 */
import { erc20Abi, parseUnits } from "viem";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { SettleError, VerifyError, type PaymentPayload, type PaymentRequirements } from "@x402/core/types";
import { UptoEvmScheme, getPermit2AllowanceReadParams } from "@x402/evm/upto/client";
import { FACILITATOR_URL, NETWORK, PERMIT2, SETTLE, USDG, payToFor, payerAccount, publicClient, supportedKind, txLink, u, usdgUnits, walletFor } from "./lib.js";

async function main(): Promise<void> {
  const account = payerAccount();
  const payTo = payToFor(account.address);
  const max = usdgUnits(process.argv[2] ?? "0.01", "maximum");
  const charge = parseUnits(process.argv[3] ?? "0.004", USDG.decimals);
  if (charge < 0n || charge > max) throw new Error("the charge must be between 0 and the maximum");

  // 1. upto on? /supported names the facilitator wallet the payer signs for (witness.facilitator).
  const kind = await supportedKind("upto");
  const facilitatorAddress = String(kind.extra?.facilitatorAddress ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(facilitatorAddress)) throw new Error("/supported lists upto without a facilitatorAddress");
  console.log(`upto is on · settling wallet ${facilitatorAddress}`);

  // 2. The Permit2 allowance must cover the maximum. Approve exactly the maximum, never unlimited.
  const allowance = await publicClient.readContract(getPermit2AllowanceReadParams({ tokenAddress: USDG.address, ownerAddress: account.address }));
  console.log(`payer ${account.address} · Permit2 allowance ${u(allowance)} USDG`);
  if (allowance < max) {
    if (!SETTLE) {
      console.log(`  the allowance is below ${u(max)}: /verify will refuse it. SETTLE=1 sends the approve first.`);
    } else {
      const hash = await walletFor(account).writeContract({ address: USDG.address, abi: erc20Abi, functionName: "approve", args: [PERMIT2, max] });
      console.log(`  approve Permit2 for ${u(max)} USDG: ${txLink(hash)}`);
      const rc = await publicClient.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error("the approve reverted");
    }
  }

  // 3. The payer signs the maximum. The seller later settles `charge` against the same signed payment.
  const requirementsFor = (amount: bigint): PaymentRequirements => ({
    scheme: "upto",
    network: NETWORK,
    asset: USDG.address,
    amount: amount.toString(),
    payTo,
    maxTimeoutSeconds: 300,
    extra: { facilitatorAddress },
  });
  const signedFor = requirementsFor(max);
  const signed = await new UptoEvmScheme(account).createPaymentPayload(2, signedFor);
  const payment: PaymentPayload = { x402Version: 2, accepted: signedFor, payload: signed.payload };
  console.log(`signed at most ${u(max)} USDG to ${payTo}`);

  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  try {
    const v = await facilitator.verify(payment, signedFor);
    console.log(`/verify (the maximum): ${v.isValid ? "valid" : `not valid: ${v.invalidReason}`}`);
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
    console.log("dry run: nothing moved. Run with SETTLE=1 to settle the charge.");
    return;
  }

  // 4. Settle only what was used: the requirement's amount is the actual charge.
  const used = requirementsFor(charge);
  try {
    let s = await facilitator.settle(payment, used);
    for (let i = 0; i < 6 && !s.success && s.errorReason === "settlement_pending"; i++) {
      await new Promise((r) => setTimeout(r, 10_000));
      s = await facilitator.settle(payment, used);
    }
    if (!s.success) console.log(`not settled: ${s.errorReason} ${s.errorMessage ?? ""}`);
    else console.log(s.transaction ? `settled ${u(charge)} USDG: ${txLink(s.transaction)}` : "charge 0: no transaction (the signature expires unused)");
  } catch (e) {
    if (e instanceof SettleError) console.log(`not settled: ${e.errorReason} ${e.errorMessage ?? ""}`);
    else throw e;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
