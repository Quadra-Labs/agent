// keywordExtractorAgent.ts — an EXAMPLE SCORELESS content agent built with the Developer Agent
// Framework. It sells one job: extract the most salient keywords/tags from a block of text the
// user provides. There is no fair way to score a tag list, so this agent is SCORELESS: it is paid
// on delivery, never evaluated, and cannot join competitions (the user trusts the result).
//
// Unlike seoArticleAgent.ts (which delegates to the default LLM producer), this agent owns a
// genuinely DETERMINISTIC skill: pure word-frequency ranking over the input minus a stopword set.
// No LLM, no fs, no process, and — because tag extraction needs no remote data — no ctx.http call
// either. The same input always yields the same keywords, so the result is reproducible and cheap.

import { z } from "zod";

import { defineAgent, defineSkill } from "../src/index.js";

// How many top tokens to surface as keywords (capped; short texts surface fewer).
const MAX_KEYWORDS = 10;
// Tokens shorter than this are dropped as noise ("a", "in", "to", stray initials).
const MIN_TOKEN_LENGTH = 3;

// A compact English stopword set: high-frequency function words that carry no topical signal.
// Kept as a Set for O(1) membership; lowercased to match the normalized tokens.
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her",
  "was", "one", "our", "out", "day", "get", "has", "him", "his", "how", "man", "new",
  "now", "old", "see", "two", "way", "who", "did", "its", "let", "put", "say", "she",
  "too", "use", "that", "with", "have", "this", "will", "your", "from", "they", "know",
  "want", "been", "good", "much", "some", "time", "very", "when", "come", "here", "just",
  "like", "long", "make", "many", "more", "only", "over", "such", "take", "than", "them",
  "then", "well", "were", "what", "into", "also", "their", "there", "these", "would",
  "about", "which", "after", "could", "other", "those", "while",
]);

/**
 * extract_keywords — pull the most salient keywords/tags from a block of text by pure
 * word-frequency ranking. Deterministic and offline: lowercase, split on non-letters,
 * drop short tokens + stopwords, count occurrences, then rank by frequency (ties broken
 * alphabetically so the result is stable). Returns { keywords } as a comma-separated
 * string, matching the content template's output schema.
 */
export const extractKeywords = defineSkill({
  name: "extract_keywords",
  description:
    "Extract the top keywords/tags from a block of text by deterministic word-frequency ranking minus stopwords, returned as a comma-separated string.",
  input: z.object({
    text: z.string(),
  }),
  output: z.object({
    keywords: z.string(),
  }),
  run({ input }) {
    // Normalize: lowercase, then split on any run of non-letter characters into raw tokens.
    const tokens = input.text
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t));

    // Count occurrences. Preserve first-seen order so the alphabetical tie-break is the only
    // ordering rule that matters (insertion order is irrelevant once we sort).
    const counts = new Map<string, number>();
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }

    // Rank by descending frequency; break ties alphabetically for a stable, reproducible list.
    const ranked = Array.from(counts.entries()).sort((a, b) => {
      const byCount = (b[1] ?? 0) - (a[1] ?? 0);
      if (byCount !== 0) return byCount;
      return (a[0] ?? "").localeCompare(b[0] ?? "");
    });

    const keywords = ranked
      .slice(0, MAX_KEYWORDS)
      .map((entry) => entry[0] ?? "")
      .filter((word) => word.length > 0)
      .join(", ");

    return { keywords };
  },
});

export const keywordExtractorAgent = defineAgent({
  name: "KeywordExtractor",
  scoreless: true,
  bio: [
    "I extract the most salient keywords and tags from any block of text you give me, delivered sealed.",
    "I am a scoreless agent: you pay on delivery and trust the result — there is no scoring.",
  ],
  systemPrompt: [
    "You are KeywordExtractor, a scoreless content agent that sells ONE job: extracting the top",
    "keywords/tags from a block of text the user provides.",
    "Rules you MUST follow:",
    "- This is a SCORELESS job: there is no asset and no lifetime/scoring window. Do not ask for an",
    "  asset or a time window, and do not promise any accuracy score.",
    "- You only do keyword/tag extraction from text. Politely decline requests outside that field",
    "  (you do not write articles, translate, summarize, or forecast).",
    "- The user must provide the text to extract keywords from before you accept.",
    "- You charge a FLAT FEE of 10 QUADRA per extraction. State this price whenever you discuss or",
    "  accept a job; never leave the price unstated.",
    "- You return a comma-separated keyword list; you never invent it yourself — it is produced for",
    "  you deterministically from the text after the job is accepted.",
    "- As soon as the user has given you the text, ACCEPT the job in EXACTLY this one-line form",
    "  (keep the label, scoreless so name the price only):",
    "  'Accepted: keyword extraction, price 10 QUADRA.'",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["content"],
  skills: [extractKeywords],
});

export default keywordExtractorAgent;
