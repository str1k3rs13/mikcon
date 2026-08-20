// Pure: how many billing cycles a wallet can renew from `due` up to `today`, and the resulting
// due date + remaining balance. No router, no clock — decided entirely from the inputs so the
// agent's renewal engine (agent-host.js) can be tested without a real router.
import { addCycle } from "./billing.js";

export function computeRenewal({ due, wallet, price, cycle, today, cap = 24 }) {
  let w = Math.max(0, Number(wallet) || 0);
  const p = Number(price) || 0;
  let d = String(due || "");
  let rounds = 0;
  if (p <= 0 || !d) return { rounds: 0, newDue: d, newWallet: w };
  // If the wallet runs out before due reaches today, the customer is renewed only as far as their credit covers and stays overdue by design — never advanced past what they paid for.
  // Renew while the bill is due (due <= today), the wallet covers a cycle, and we're under the cap.
  while (rounds < cap && w >= p && d <= String(today)) {
    w -= p;
    d = addCycle(d, cycle);
    rounds++;
  }
  return { rounds, newDue: d, newWallet: w };
}
