const express = require("express");
const Stripe = require("stripe");

const BILLING_INTERVALS = new Set(["month", "year"]);

function getPlanFromSubscriptionStatus(status) {
  const normalized = String(status || "")
    .trim()
    .toLowerCase();
  if (normalized === "active" || normalized === "trialing") return "premium";
  return "free";
}

function normalizeInterval(interval) {
  const normalized = String(interval || "")
    .trim()
    .toLowerCase();
  return BILLING_INTERVALS.has(normalized) ? normalized : null;
}

function readBillingStatusFromUser(user, quotas) {
  const metadata = user?.app_metadata || {};
  const priceId = String(metadata.stripe_price_id || "");
  const interval =
    priceId && priceId === process.env.STRIPE_PRICE_ID_ANNUAL ? "year" : "month";
  const plan = String(metadata.plan || "free").toLowerCase() === "premium" ? "premium" : "free";
  return {
    plan,
    status: metadata.stripe_subscription_status || null,
    interval: metadata.stripe_subscription_id ? interval : null,
    trialEndsAt: metadata.trial_ends_at || null,
    stripeCustomerId: metadata.stripe_customer_id || null,
    quotas: quotas[plan] || quotas.free,
  };
}

function createBillingRouter({
  supabase,
  requireAuth,
  requirePremium,
  planQuotas,
}) {
  const stripeSecret = String(process.env.STRIPE_SECRET_KEY || "").trim();
  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  const appBaseUrl = String(process.env.APP_BASE_URL || "").trim();
  const monthlyPriceId = String(process.env.STRIPE_PRICE_ID_MONTHLY || "").trim();
  const annualPriceId = String(process.env.STRIPE_PRICE_ID_ANNUAL || "").trim();
  const trialDays = Number.parseInt(process.env.STRIPE_TRIAL_DAYS || "7", 10) || 7;

  const billingConfigured = Boolean(
    stripeSecret && webhookSecret && monthlyPriceId && annualPriceId && appBaseUrl,
  );
  const stripe = billingConfigured
    ? new Stripe(stripeSecret, { apiVersion: "2025-08-27.basil" })
    : null;
  const router = express.Router();

  function ensureBillingConfigured(res) {
    if (billingConfigured) return true;
    res.status(503).json({
      error: "Billing is not configured yet.",
      code: "BILLING_NOT_CONFIGURED",
    });
    return false;
  }

  async function updateUserBillingMetadata(userId, patch) {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data?.user) {
      throw new Error(error?.message || "Unable to load user during billing sync");
    }
    const nextMetadata = {
      ...(data.user.app_metadata || {}),
      ...patch,
    };
    const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
      app_metadata: nextMetadata,
    });
    if (updateError) throw new Error(updateError.message);
  }

  async function syncSubscriptionToSupabase(subscription) {
    const userId = subscription?.metadata?.supabase_user_id;
    if (!userId) return;
    const firstPrice = subscription?.items?.data?.[0]?.price;
    const plan = getPlanFromSubscriptionStatus(subscription?.status);
    await updateUserBillingMetadata(userId, {
      plan,
      stripe_subscription_status: subscription?.status || null,
      stripe_subscription_id: subscription?.id || null,
      stripe_customer_id:
        typeof subscription?.customer === "string"
          ? subscription.customer
          : subscription?.customer?.id || null,
      stripe_price_id: firstPrice?.id || null,
      trial_ends_at: subscription?.trial_end
        ? new Date(subscription.trial_end * 1000).toISOString()
        : null,
      trial_used:
        Boolean(subscription?.trial_start) ||
        Boolean(subscription?.trial_end) ||
        undefined,
    });
  }

  async function getOrCreateCustomerForUser(user) {
    const metadata = user?.app_metadata || {};
    if (metadata.stripe_customer_id) return metadata.stripe_customer_id;
    const created = await stripe.customers.create({
      email: user.email || undefined,
      metadata: {
        supabase_user_id: user.id,
      },
    });
    await updateUserBillingMetadata(user.id, {
      stripe_customer_id: created.id,
    });
    return created.id;
  }

  router.get("/status", requireAuth, async (req, res) => {
    try {
      if (!ensureBillingConfigured(res)) return;
      return res.json(readBillingStatusFromUser(req.user, planQuotas));
    } catch (error) {
      return res.status(500).json({ error: "Failed to load billing status" });
    }
  });

  router.post("/checkout", requireAuth, async (req, res) => {
    try {
      if (!ensureBillingConfigured(res)) return;
      const interval = normalizeInterval(req.body?.interval);
      if (!interval) {
        return res.status(400).json({ error: "interval must be month or year" });
      }
      const user = req.user;
      const customerId = await getOrCreateCustomerForUser(user);
      let hasUsedTrial = Boolean(user?.app_metadata?.trial_used);
      if (!hasUsedTrial) {
        const priorSubs = await stripe.subscriptions.list({
          customer: customerId,
          status: "all",
          limit: 1,
        });
        hasUsedTrial = (priorSubs.data || []).length > 0;
      }
      const priceId = interval === "year" ? annualPriceId : monthlyPriceId;
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${appBaseUrl}?billing=success`,
        cancel_url: `${appBaseUrl}?billing=cancel`,
        client_reference_id: user.id,
        metadata: {
          supabase_user_id: user.id,
          interval,
        },
        subscription_data: {
          metadata: { supabase_user_id: user.id, interval },
          ...(hasUsedTrial ? {} : { trial_period_days: trialDays }),
        },
      });
      return res.json({ url: session.url });
    } catch (error) {
      console.error("Checkout session error:", error?.message || error);
      return res.status(500).json({ error: "Failed to create checkout session" });
    }
  });

  router.post("/portal", requireAuth, async (req, res) => {
    try {
      if (!ensureBillingConfigured(res)) return;
      const customerId = await getOrCreateCustomerForUser(req.user);
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: appBaseUrl,
      });
      return res.json({ url: session.url });
    } catch (error) {
      return res.status(500).json({ error: "Failed to create billing portal session" });
    }
  });

  router.get("/usage", requireAuth, async (req, res) => {
    const status = readBillingStatusFromUser(req.user, planQuotas);
    return res.json({
      plan: status.plan,
      quotas: status.quotas,
      status: status.status,
      trialEndsAt: status.trialEndsAt,
    });
  });

  router.get("/premium/feature/:feature", requireAuth, requirePremium, (req, res) => {
    return res.json({ ok: true, feature: req.params.feature });
  });

  async function webhookHandler(req, res) {
    if (!billingConfigured) {
      return res.status(503).json({ error: "Billing is not configured yet." });
    }
    let event;
    try {
      const signature = req.get("stripe-signature");
      event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
    } catch (err) {
      return res.status(400).json({ error: "Invalid webhook signature" });
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        if (session?.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          await syncSubscriptionToSupabase(subscription);
        }
      } else if (
        event.type === "customer.subscription.updated" ||
        event.type === "customer.subscription.deleted" ||
        event.type === "customer.subscription.created"
      ) {
        await syncSubscriptionToSupabase(event.data.object);
      }
      return res.json({ received: true });
    } catch (error) {
      return res.status(500).json({ error: "Webhook processing failed" });
    }
  }

  return { router, webhookHandler, getPlanFromSubscriptionStatus, normalizeInterval };
}

module.exports = {
  BILLING_INTERVALS,
  createBillingRouter,
  getPlanFromSubscriptionStatus,
  normalizeInterval,
  readBillingStatusFromUser,
};
