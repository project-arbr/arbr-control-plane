// Shadow-eval: mirror a sampled fraction of an app's single-shot traffic to a candidate
// model AFTER the prod response is already served, judge candidate-vs-prod, and record the
// pair. Called fire-and-forget from the gateway's post-response setImmediate block. It must
// NEVER throw into or delay the served request.
const EvalCampaign = require("../models/EvalCampaign");
const EvalPair = require("../models/EvalPair");
const Settings = require("../models/Settings");
const pricing = require("../pricing/registry");
const { maskMessages, maskPii, clampText } = require("../logging/piiFilter");
const { judge } = require("./judge");
const { isSingleShot, shouldSample, withinWindow, campaignMatches } = require("./logic");
const { internalComplete } = require("../internal/complete");

function shadowPayload({ messages, prodText, candidateText }, settings) {
  if (settings?.captureRequestPayloads === false) {
    return { messages: null, prodResponse: null, candidateResponse: null };
  }
  const mask = !!settings?.piiMaskingEnabled;
  const patterns = settings?.customPiiPatterns || [];
  const msgArr = Array.isArray(messages) ? messages : [{ role: "user", content: String(messages ?? "") }];
  return {
    messages: mask ? maskMessages(msgArr, patterns) : msgArr,
    prodResponse: clampText(mask ? maskPii(prodText || "", patterns) : (prodText || "")),
    candidateResponse: clampText(mask ? maskPii(candidateText || "", patterns) : (candidateText || "")),
  };
}

// Short-lived active-campaign cache per application (mirrors getAppConfig in handler.js).
const _campaignCache = new Map(); // application -> { campaign, expiresAt }
async function getActiveCampaign(application) {
  if (!application || application === "unknown") return null;
  const cached = _campaignCache.get(application);
  if (cached && cached.expiresAt > Date.now()) return cached.campaign;
  const campaign = await EvalCampaign.findOne({ application, status: "active" }).catch(() => null);
  _campaignCache.set(application, { campaign, expiresAt: Date.now() + 30_000 });
  return campaign;
}
function invalidateCampaignCache() { _campaignCache.clear(); }

function costOf(model, usage) {
  const u = usage || {};
  return pricing.costFor(model, u.inputTokens || 0, u.outputTokens || 0).totalCost;
}

// Candidate spend for this campaign since UTC midnight — enforces maxDailyShadowBudgetUsd.
async function spentTodayUsd(campaignId) {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const agg = await EvalPair.aggregate([
    { $match: { campaignId, timestamp: { $gte: since } } },
    { $group: { _id: null, total: { $sum: "$candidateCost" } } },
  ]).catch(() => []);
  return agg.length ? (agg[0].total || 0) : 0;
}

// Count a candidate call failure; pause the campaign once maxCandidateErrors is hit.
async function recordCandidateError(campaign) {
  const count = (campaign.candidateErrorCount || 0) + 1;
  const update = { candidateErrorCount: count };
  if (campaign.maxCandidateErrors != null && count >= campaign.maxCandidateErrors) {
    update.status = "paused";
    update.statusReason = `candidate error cap (${campaign.maxCandidateErrors}) reached`;
  }
  await EvalCampaign.updateOne({ _id: campaign._id }, { $set: update }).catch(() => {});
  invalidateCampaignCache();
}

// Fire the "safe to switch" webhook once thresholds clear.
async function checkThresholdAndNotify(campaign) {
  if (campaign.notifiedAt) return;
  const t = campaign.thresholds || {};
  const minPairs = t.minPairs || 50;
  const maxLossRate = t.maxLossRate != null ? t.maxLossRate : 0.1;
  const judged = await EvalPair.find({ campaignId: campaign._id, verdict: { $ne: null } }, { verdict: 1 }).lean();
  if (judged.length < minPairs) return;
  const loss = judged.filter((p) => p.verdict === "worse").length / judged.length;
  if (loss > maxLossRate) return;
  const s = await Settings.get().catch(() => null);
  const url = s?.webhookUrl;
  if (url) {
    const payload = {
      text: `Arbr shadow-eval: candidate "${campaign.candidateModel}" looks healthy for app `
          + `"${campaign.application}" (${judged.length} judged, ${(loss * 100).toFixed(1)}% worse). Safe to switch.`,
      campaignId: String(campaign._id), application: campaign.application,
      candidateModel: campaign.candidateModel, judgedPairs: judged.length, lossRate: loss,
    };
    try {
      await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } catch { /* swallow */ }
  }
  campaign.notifiedAt = new Date();
  await campaign.save().catch(() => {});
}

// prod = { model, provider, latencyMs, text, usage }
async function maybeShadowEval({ application, workflow, taskType, messages, hasTools, requestId, prod, router, eff }) {
  try {
    const campaign = await getActiveCampaign(application);
    if (!campaign || !router || !eff) return;
    if (!withinWindow(Date.now(), campaign.startDate, campaign.endDate)) return; // outside date window
    if (!campaignMatches(campaign, { taskType, workflow, baselineModel: prod.model })) return; // scope filter
    if (!isSingleShot(messages, hasTools)) return;
    if (!shouldSample(Math.random(), campaign.sampleRate)) return;
    const cm = pricing.getModel(campaign.candidateModel);
    if (!cm || !eff.liveIds.includes(cm.provider)) return;   // candidate not live → skip
    if (cm.id === prod.model) return;                        // same model → nothing to compare

    // Daily shadow budget: stop mirroring once today's candidate spend hits the cap.
    if (campaign.maxDailyShadowBudgetUsd != null && await spentTodayUsd(campaign._id) >= campaign.maxDailyShadowBudgetUsd) return;

    const candidate = await internalComplete({
      kind: "shadow-candidate", router,
      messages, provider: cm.provider, model: campaign.candidateModel,
      context: { campaignId: String(campaign._id), application, requestId },
    }).catch(() => null);
    if (!candidate) { await recordCandidateError(campaign); return; }

    const s = await Settings.get().catch(() => null);
    const stored = shadowPayload({ messages, prodText: prod.text, candidateText: candidate.text }, s);
    const pair = new EvalPair({
      campaignId: campaign._id, requestId, application, taskType, timestamp: new Date(),
      prodModel: prod.model, prodProvider: prod.provider, prodCost: costOf(prod.model, prod.usage),
      prodLatencyMs: prod.latencyMs, prodResponse: stored.prodResponse,
      candidateModel: campaign.candidateModel, candidateProvider: cm.provider,
      // From the wrapper, so the EvalPair ledger and the RequestRecord ledger price the
      // same call identically (costOf ignores prompt-cache discounts; the wrapper doesn't).
      candidateCost: candidate.costUsd, candidateLatencyMs: candidate.latencyMs,
      candidateResponse: stored.candidateResponse,
      judgeModel: campaign.judgeModel || null,
      messages: stored.messages,
    });

    const v = await judge({
      router, eff, judgeModel: campaign.judgeModel, messages, prodText: prod.text, candidateText: candidate.text,
    });
    if (v) {
      pair.verdict = v.verdict;
      pair.rationale = s?.captureRequestPayloads === false
        ? null
        : clampText(s?.piiMaskingEnabled ? maskPii(v.rationale || "", s.customPiiPatterns || []) : v.rationale);
    }
    await pair.save();

    if (pair.verdict) await checkThresholdAndNotify(campaign);
  } catch { /* never affect the served request */ }
}

module.exports = { maybeShadowEval, getActiveCampaign, invalidateCampaignCache, isSingleShot, shadowPayload };
