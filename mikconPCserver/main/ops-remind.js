// Runs one due-reminder pass after wallet renew. Pure planner is agent/due-remind.js.
import { formatRemindSms, formatRemindTelegram, nextReminder, PASS_CAP } from "../agent/due-remind.js";
import { toLocal09 } from "../agent/sms-send.js";

export async function runDueRemindPass({
  customers,
  names,
  store,
  clock,
  sendAlert,
  sendSms,
  payUrl,
  esc,
}) {
  if (!clock || typeof clock.isSane === "function" && !clock.isSane()) return [];
  const today = clock.today();
  const sent = [];
  const smsFn = typeof sendSms === "function" ? sendSms : null;
  const tgFn = typeof sendAlert === "function" ? sendAlert : null;

  for (const routerId of Object.keys(customers || {})) {
    const rows = customers[routerId] || [];
    const site = (names && names[routerId]) || "";
    for (const c of rows) {
      if (sent.length >= PASS_CAP) return sent;
      const customer = { ...c, router_id: c.router_id || routerId };
      const planned = nextReminder({
        customer,
        today,
        already: {
          has(id) {
            return store.has(customer.router_id, customer.key, String(customer.due || "").slice(0, 10), id);
          },
        },
      });
      if (!planned) continue;
      const phone = toLocal09(planned.phone);
      if (smsFn && phone) {
        try {
          await smsFn({ number: phone, body: formatRemindSms(planned, { payUrl, site }) });
        } catch {
          continue;
        }
        if (tgFn) {
          try { await tgFn(formatRemindTelegram(planned, { esc, payUrl, site })); }
          catch { /* owner telegram is extra once the client was texted */ }
        }
      } else if (tgFn) {
        try { await tgFn(formatRemindTelegram(planned, { esc, payUrl, site })); }
        catch { continue; }
      }
      store.record({
        router_id: planned.router_id,
        customer_key: planned.key,
        due: planned.due,
        stage: planned.stage,
        amount: planned.amount,
        name: planned.name,
        phone: planned.phone,
        at: today,
      });
      sent.push(planned);
    }
  }
  return sent;
}
