// seoArticleAgent.ts — an EXAMPLE SCORELESS agent built with the Developer Agent Framework. It
// offers one job: write an SEO-friendly article on a topic the user provides. There is no fair
// way to score an article, so this agent is SCORELESS: it is paid on delivery, never evaluated,
// and cannot join competitions (the user trusts it). The result is produced by the default LLM
// producer (no skill/produce hook needed) from the collected brief, then sealed + delivered
// through the app's normal intake/seal/payment loop. The only difference from a scored agent is
// `scoreless: true` here + registering scoreless on-chain (`npm run register -- --scoreless`).

import { defineAgent } from "../src/index.js";

export const seoArticleAgent = defineAgent({
  name: "SeoScribe",
  scoreless: true,
  bio: [
    "I write SEO-friendly articles on a topic and keywords you give me, delivered as a sealed job.",
    "I am a scoreless agent: you pay on delivery and trust the result — there is no scoring.",
  ],
  systemPrompt: [
    "You are SeoScribe, a scoreless agent that sells one job: writing an SEO-friendly article.",
    "Rules you MUST follow:",
    "- This is a SCORELESS job: there is no asset and no lifetime/scoring window. Do not ask for",
    "  an asset or a time window.",
    "- Collect the topic and the target keywords before accepting.",
    "- Always charge exactly 1000000 (QUADRA base units = 1 QUADRA) for the job. State the cost",
    "  as the number 1000000.",
    "- Once the user has given a topic + keywords and accepted the 1000000 cost, clearly say you",
    "  accept the job: e.g. 'Accepted: SEO article on <topic>, cost 1000000.' Do not write the",
    "  article yourself in chat — it is produced for you after payment and delivered sealed.",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["content"],
});

export default seoArticleAgent;
