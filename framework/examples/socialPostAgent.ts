// socialPostAgent.ts — an EXAMPLE SCORELESS content agent built with the Developer Agent Framework.
// It sells one job: turn a topic into a short, tweet-length social post (<=280 chars) with a couple
// of hashtags derived from the topic. There is no fair way to score a social post, so this agent is
// SCORELESS: it is paid on delivery, never evaluated, and cannot join competitions (the user trusts
// the result). Unlike seoArticleAgent.ts (which leaves drafting to the default LLM producer), the
// formatting here is a DETERMINISTIC skill: no LLM, no fs/process, and no external API — the only
// thing it does is shape the given topic into a post. The bridge runs it through the app's normal
// intake/seal/payment loop (register scoreless on-chain via `npm run register -- --scoreless`).

import { z } from "zod";

import { defineAgent, defineSkill } from "../src/index.js";

// Twitter-style hard limit; the post must fit within this many characters including the hashtags.
const MAX_POST_CHARS = 280;
// How many topic-derived hashtags to append.
const HASHTAG_COUNT = 2;
// Common words we never turn into hashtags (they make weak, noisy tags).
const STOP_WORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with",
  "at", "by", "from", "as", "is", "are", "be", "this", "that", "it", "your",
  "you", "we", "our", "how", "why", "what", "when",
]);

/** Keep only letters/digits, collapsing everything else, so a word makes a clean #hashtag. */
function toTagWord(word: string): string {
  return word.replace(/[^a-zA-Z0-9]/g, "");
}

/**
 * Pick up to HASHTAG_COUNT hashtags from the topic: the longest, most distinctive non-stop words,
 * deduped and order-preserving. Falls back to a generic tag when the topic yields none.
 */
function deriveHashtags(topic: string): string[] {
  const words = topic.split(/\s+/).map(toTagWord).filter((w) => w.length > 0);

  const seen: Set<string> = new Set();
  const candidates: string[] = [];
  for (const word of words) {
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower) || word.length < 3 || seen.has(lower)) continue;
    seen.add(lower);
    candidates.push(word);
  }

  // Prefer the more distinctive (longer) words, but keep ties in original order.
  const ranked = [...candidates].sort((a, b) => b.length - a.length);
  const chosen = ranked.slice(0, HASHTAG_COUNT);
  const tags = chosen.map((w) => `#${w.charAt(0).toUpperCase()}${w.slice(1)}`);

  return tags.length > 0 ? tags : ["#Update"];
}

/** Truncate body text so that body + " " + hashtags fits within MAX_POST_CHARS, ending cleanly. */
function fitBody(body: string, tagsLength: number): string {
  // Room left for the body once a space and the hashtag string are reserved.
  const room = Math.max(0, MAX_POST_CHARS - tagsLength - 1);
  if (body.length <= room) return body;
  if (room === 0) return "";
  // Trim to the last whole word that fits, then add an ellipsis if we cut mid-thought.
  const slice = body.slice(0, room);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  const ellipsis = "...";
  if (cut.length + ellipsis.length <= room) return `${cut}${ellipsis}`;
  return cut;
}

/**
 * draft_social_post — DETERMINISTIC: shape a topic into a single tweet-length (<=280 char) social
 * post with a couple of topic-derived hashtags. No LLM, no external API, no fs/process. The body is
 * a light lead-in over the cleaned topic; hashtags are the most distinctive words in the topic.
 * Returns only { post }, matching the content template's output schema.
 */
export const draftSocialPost = defineSkill({
  name: "draft_social_post",
  description:
    "Format a topic into a single tweet-length (<=280 char) social post with a couple of topic-derived hashtags. Deterministic: no LLM and no external API.",
  input: z.object({
    topic: z.string().min(1),
  }),
  output: z.object({
    post: z.string(),
  }),
  async run({ input }) {
    // Normalize whitespace so the body reads as one tidy line.
    const topic = input.topic.replace(/\s+/g, " ").trim();
    const tags = deriveHashtags(topic);
    const hashtags = tags.join(" ");

    // A neutral lead-in keeps the body usable without an LLM; capitalize the first letter.
    const headline = topic.length > 0
      ? `${topic.charAt(0).toUpperCase()}${topic.slice(1)}`
      : "An update";
    const rawBody = `${headline} — here is the quick take.`;

    const body = fitBody(rawBody, hashtags.length);
    const post = body.length > 0 ? `${body} ${hashtags}` : hashtags.slice(0, MAX_POST_CHARS);

    return { post: post.slice(0, MAX_POST_CHARS) };
  },
});

export const socialPostAgent = defineAgent({
  name: "SocialPostScribe",
  scoreless: true,
  bio: [
    "I draft a short, tweet-length social post (<=280 chars) from a topic you give me, delivered sealed.",
    "I am a scoreless agent: you pay on delivery and trust the result — there is no scoring.",
  ],
  systemPrompt: [
    "You are SocialPostScribe, a scoreless agent that sells ONE job: drafting a short, tweet-length",
    "social post (<=280 characters) with a couple of hashtags from a topic the user gives you.",
    "Rules you MUST follow:",
    "- You only draft short social posts. Politely decline requests outside that field (long-form",
    "  articles, code, forecasts, and the like are not your job).",
    "- This is a SCORELESS job: there is no asset and no lifetime/scoring window. Do not ask for an",
    "  asset or a time window, and do not mention scoring.",
    "- The user must provide a topic before you accept.",
    "- You charge a FLAT FEE of 10 QUADRA per post. State this price whenever you discuss or accept a",
    "  job; never leave the price unstated.",
    "- You never write the post yourself in chat — it is formatted for you from the topic after the",
    "  job is accepted and delivered sealed.",
    "- As soon as the user has given you a topic, ACCEPT the job in EXACTLY this one-line form (fill",
    "  the angle brackets, keep the labels):",
    "  'Accepted: social post on <topic>, price 10 QUADRA.'",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["content"],
  skills: [draftSocialPost],
});

export default socialPostAgent;
