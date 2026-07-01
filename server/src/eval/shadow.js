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
const { isSingleShot, shouldSample } = require("./logic");

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
async function maybeShadowEval({ application, taskType, messages, hasTools, requestId, prod, router, eff }) {
  try {
    const campaign = await getActiveCampaign(application);
    if (!campaign || !router || !eff) return;
    if (!isSingleShot(messages, hasTools)) return;
    if (!shouldSample(Math.random(), campaign.sampleRate)) return;
    const cm = pricing.getModel(campaign.candidateModel);
    if (!cm || !eff.liveIds.includes(cm.provider)) return;   // candidate not live → skip
    if (cm.id === prod.model) return;                        // same model → nothing to compare

    const candidate = await router.complete({
      messages, providerOverride: cm.provider, modelOverride: campaign.candidateModel,
    }).catch(() => null);
    if (!candidate) return;

    const s = await Settings.get().catch(() => null);
    const mask = !!s?.piiMaskingEnabled;
    const msgArr = Array.isArray(messages) ? messages : [{ role: "user", content: String(messages ?? "") }];
    const pair = new EvalPair({
      campaignId: campaign._id, requestId, application, taskType, timestamp: new Date(),
      prodModel: prod.model, prodProvider: prod.provider, prodCost: costOf(prod.model, prod.usage),
      prodLatencyMs: prod.latencyMs, prodResponse: clampText(mask ? maskPii(prod.text || "") : (prod.text || "")),
      candidateModel: campaign.candidateModel, candidateProvider: cm.provider,
      candidateCost: costOf(campaign.candidateModel, candidate.usage), candidateLatencyMs: candidate.latencyMs,
      candidateResponse: clampText(mask ? maskPii(candidate.text || "") : (candidate.text || "")),
      judgeModel: campaign.judgeModel || null,
      messages: mask ? maskMessages(msgArr) : msgArr,
    });

    const v = await judge({
      router, eff, judgeModel: campaign.judgeModel, messages, prodText: prod.text, candidateText: candidate.text,
    });
    if (v) { pair.verdict = v.verdict; pair.rationale = v.rationale; }
    await pair.save();

    if (pair.verdict) await checkThresholdAndNotify(campaign);
  } catch { /* never affect the served request */ }
}

module.exports = { maybeShadowEval, getActiveCampaign, invalidateCampaignCache, isSingleShot };
