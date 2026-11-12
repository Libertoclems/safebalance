# SafeBalance (pilot build, test mode)

Escrow for Nigerian artisans and freelancers. The client locks money for each
stage before work starts; it is released when they approve, automatically if
they stay silent past the review window, or by a mediator if there's a dispute.

**This build is in test mode. No real money moves.** Payments, payouts and
BVN/NIN checks are simulated until a licensed partner is connected.

## Run it

Needs Node.js 20 or newer.

```bash
npm install
cp .env.example .env      # then change the secrets in .env
npm run db:setup          # creates the local database
npm run dev               # http://localhost:3000
npm run worker            # in a second terminal: auto-release + notifications
npm test                  # 50 tests: money, instalments, WhatsApp, mediator
```

If npm asks you to approve install scripts, approve `prisma`, `@prisma/client`,
`@prisma/engines` and `esbuild` (`npm install-scripts approve <name>`).

## Try a full deal

1. Sign in with any Nigerian number (e.g. 0803 111 2222). In test mode the
   6-digit code is shown on screen.
2. **New deal**: add stages. Tick "Materials money" to release a stage as soon
   as it's funded, optionally straight to a supplier.
3. Open the deal link in another browser (or sign out) and sign in as the
   client with a different number. Accept the terms.
4. **Pay to lock this stage** shows a one-off account number. In test mode,
   **Simulate bank transfer** sends a signed payment notice through the real
   webhook route.
5. As the worker, upload a photo as proof. The client can approve, raise an
   issue, or wait; **Skip the review timer (test)** shows auto-release.
6. Under **Account**, verify a BVN/NIN (any 11 digits in test mode) and add a
   bank account. Money owed is paid out automatically.
7. Sign in with the number in `ADMIN_PHONES` to see **Admin**: ledger check,
   open disputes (settle with a split), unmatched transfers, failed payouts.

Sandbox rule: payouts to an account number ending in `000` fail, so failure
handling can be tested.

## WhatsApp bot

Workers and clients can do the whole deal in WhatsApp: create a deal, join
with a code, pay, send proof photos, approve or raise an issue. Both sides also
get WhatsApp updates for deals made on the website. Accounts are matched by
phone number, so the website and WhatsApp share the same account.

**Try it in test mode:** open http://localhost:3000/dev/whatsapp. Two
simulated phones (a worker and a client) talk to the bot through the same
webhook parser the live service uses. Nothing is sent to Meta.

1. Worker phone: send `hi`, tap **New deal**, send the job title, then the
   stages, one per line or separated by `;`, e.g. `Materials 150k; Fitting 120,000`.
   A stage starting with "Materials" is paid out as soon as the client pays.
2. Copy the `JOIN <code>` from the message meant for the client and send it
   from the client phone. Tap **Accept terms**, **Pay stage 1**, **Simulate transfer**.
3. Worker phone: send a photo. It's attached as proof to the paid stage.
4. Client phone: tap **Approve & pay** on the notification, then **Yes, release**.

Things people can type: `NEW`, `DEALS`, `JOIN <code>`, `HELP`, `MENU`, `CANCEL`.

**Going live on WhatsApp** (needs a Meta Business account and a phone number
for the bot):

- [ ] Create an app in Meta for Developers with the WhatsApp product; add the
      bot's phone number and verify the business.
- [ ] Fill in `.env`: `WHATSAPP_MODE="cloud"`, `WHATSAPP_TOKEN` (a permanent
      system-user token), `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`,
      `WHATSAPP_VERIFY_TOKEN` (any long random string), `WHATSAPP_BOT_NUMBER`.
- [ ] In the Meta app, set the webhook to `https://<your domain>/api/whatsapp`
      with the same verify token, and subscribe to `messages`. The app must be
      on a public HTTPS address.
- [ ] Get a **utility** message template approved, named `deal_update`,
      language English, body `SafeBalance update: {{1}}`. WhatsApp only allows
      templates when the person hasn't messaged the bot in the last 24 hours, so
      updates outside that window use this template.
- [ ] Check WhatsApp's current pricing and policies for utility messages
      before launch; they change from time to time.

Limits to know: up to 3 buttons per message and 20 characters per button
(the bot trims to fit); photos and videos up to 15 MB are accepted as proof.

## Pay small small (paying in parts)

Clients who don't have a stage's full amount can pay it in parts:

- Any transfer to the stage's account counts. Each one is locked for the job,
  and both sides get a receipt with progress ("₦101,500 of ₦203,000 saved, 50%").
- The stage shows **Funds secured** only at 100%, and only then can the
  worker submit proof. Workers are told not to start before that.
- Optional plan: 2–12 parts, every week, 2 weeks or month. WhatsApp reminder
  the day before each part, and one nudge if it's 3 days late. Paying early or
  more is fine.
- Anything paid beyond what's needed is refunded automatically. If the deal
  is cancelled before work starts (by either side), everything saved goes back.
- Saved money never earns interest or returns.
- Stages are still paid in order. A materials stage is released only once fully paid.

Try it: as the client, open the deal, tap **Pay … to lock this stage**, then
**Don't have it all now? Pay small small**, and use **Simulate part payment**.
On WhatsApp: **Pay stage N** → **Pay in parts**.

Note for the payment partner: per-stage account numbers must accept several
transfers of any amount (not just one exact amount). Confirm this when choosing
a partner.

## AI dispute mediator

When a client raises an issue, the money stays locked and:

1. The worker gets **48 hours to give their side** (web or WhatsApp "Give my side").
2. The mediator reads the agreed terms, both statements, the proof photos
   (with their times) and the deal history, and **suggests a split** with its
   findings and reasons. If the worker doesn't answer in time, it goes ahead.
3. Both sides see the suggestion and tap **Accept** or **Reject**.
   **Money moves only if both accept.** If either rejects, a person decides
   on the admin page, with the AI's notes as support.

It always goes straight to a person when the mediator isn't confident, flags
the case (safety, fraud, threats, missing evidence), the stage is over
`MEDIATOR_MAX_AUTO_NAIRA` (default ₦1,000,000), the AI declines or can't be
reached after 3 tries, or mediation is turned off. Admins can settle any open
dispute at any time.

Safety details:
- What the parties write is passed to the model as marked evidence, never as
  instructions, and can't break out of its tags (covered by a test).
- The model returns a fixed structure (structured outputs); our code clamps
  the percentage and works out every naira amount itself.
- Only the worker and client can add statements or answer, once each; two
  taps at the same time can't pay twice.

**Turning on real AI:** set `ANTHROPIC_API_KEY` in `.env` (from
console.anthropic.com). It uses Claude Opus 5.5 at high effort with automatic
fallback to another model if it declines a case. Without a key in test mode
it runs a clearly labelled **demo** that uses a fixed rule (60% to the worker
if they responded, 40% if not) so you can try the flow. Rough cost: about
5–15 US cents per dispute at Opus 5.5 prices ($4 / $20 per million input /
output tokens), more with many photos. This is an estimate, not measured;
check current API pricing and your usage once it runs on real disputes.

**Before relying on it with real money:** run it on a set of realistic past
disputes and compare its suggestions with what a human mediator decided; have
a lawyer confirm the mediation clause covers AI-assisted suggestions.

Try it: create a deal, fund a stage, upload proof, then as the client raise an
issue. As the worker, give your side (or use **Skip the 48-hour wait (test)**).
The suggestion appears on the deal page and in the WhatsApp simulator.

## How it's built

| Part | Where |
| --- | --- |
| Deal rules (fund, release, dispute, refund, change orders) | `src/lib/deals.ts` |
| Double-entry ledger, health check | `src/lib/ledger.ts` |
| Payouts with failure reversal | `src/lib/payouts.ts` |
| Payment partner interface + sandbox | `src/lib/payments/` |
| Fees and naira/kobo handling | `src/lib/money.ts` |
| Phone + one-time code sign-in | `src/lib/auth.ts` |
| AI mediator: flow, evidence, Claude/demo engines | `src/lib/mediator/` |
| WhatsApp bot conversations | `src/lib/whatsapp/bot.ts` |
| WhatsApp sending, templates, media, signature check | `src/lib/whatsapp/transport.ts` |
| Deal-update notifications (outbox) | `src/lib/whatsapp/notify.ts` |
| WhatsApp webhook / test simulator | `src/app/api/whatsapp`, `src/app/dev/whatsapp` |
| Screens | `src/app/` (deal page: `src/app/d/[code]`) |
| Data model | `prisma/schema.prisma` |
| Tests | `tests/` |

Key safety rules:
- Money is stored in kobo as whole numbers; every ledger transaction must sum
  to zero, and the admin page checks the whole ledger.
- Every money movement has a unique reference, so a repeated bank notice or a
  double tap can't pay twice (both covered by tests).
- A transfer for a stage that is not taking payment (already paid, cancelled,
  unknown reference) goes to "unmatched transfers" for an admin. Short
  transfers count as part payments; extra money is refunded.
- Payouts need a verified ID and saved bank details; a failed payout is put
  back so it can be retried.

## Moving to production (not done yet)

- [ ] **Licensed partner.** Sign with a partner and add an adapter in
      `src/lib/payments/` (per-stage account numbers, payouts, name check,
      webhook signature), plus its webhook route. Set `PAYMENT_PROVIDER`.
- [ ] **Lawyer sign-off** on the partner model, terms and mediation clause.
- [ ] **SMS** for one-time codes (send it in `requestOtp` in `src/lib/auth.ts`).
- [ ] **Real BVN/NIN checks** through an identity provider (`verifyIdAction`).
- [ ] **Postgres**: switch the provider in `prisma/schema.prisma`, change money
      columns to `BigInt` (the pilot caps a stage at ₦20,000,000), and use row
      locks for payouts instead of the in-process lock.
- [ ] **File storage**: move proof uploads from `uploads/` to object storage.
- [ ] **Hosting**: run the web app and `npm run worker` (or a cron calling
      `autoReleaseDue`) on a server; set `APP_URL` and long random secrets.
- [ ] Tools for refunding or applying unmatched transfers.

Not in this version (planned for V2 in the spec): voice-note
agreements, AI dispute mediator, warranty hold-back, "pay small small",
retainers, USSD, and the Expo mobile app.



