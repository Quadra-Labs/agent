// textSummarizerAgent.ts — an EXAMPLE SCORELESS content agent built with the Developer Agent
// Framework. It sells one job: a short extractive summary of text the user provides. There is
// no fair way to score a summary, so this agent is SCORELESS: it is paid on delivery, never
// evaluated, and cannot join competitions (the user trusts it). Unlike seoArticleAgent — which
// leans on the default LLM producer — the summary here is produced DETERMINISTICALLY by a skill
// (extractive: it ranks and re-orders the document's own sentences, no LLM, no external API), so
// the same input always yields the same summary. The bridge in run.ts runs it through the app's
// real intake/seal/payment loop; registering scoreless on-chain is `npm run register -- --scoreless`.

import { z } from "zod";

import { defineAgent, defineSkill } from "../src/index.js";

// How many sentences the summary keeps at most (short, extractive).
const MAX_SENTENCES = 3;
// English stopwords excluded from the salience word-frequency model (they say nothing about topic).
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "for", "with", "as",
  "is", "are", "was", "were", "be", "been", "being", "it", "its", "this", "that", "these",
  "those", "at", "by", "from", "into", "than", "then", "so", "such", "not", "no", "do",
  "does", "did", "has", "have", "had", "i", "you", "he", "she", "we", "they", "them", "his",
  "her", "their", "our", "your", "my", "me", "us", "him",
]);

/** Split text into sentences on ., !, ? boundaries, keeping only non-empty trimmed sentences. */
function splitSentences(text: string): readonly string[] {
  const parts = text.split(/(?<=[.!?])\s+/);
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Lowercase content words of a string (drops punctuation, digits, and stopwords). */
function contentWords(s: string): readonly string[] {
  const tokens = s.toLowerCase().match(/[a-z]+/g) ?? [];
  return tokens.filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * summarize_text — produce a short extractive summary of `text`. The method is fully
 * deterministic: build a word-frequency salience model over the document's content words,
 * score each sentence by its summed word salience (length-normalized so long sentences do not
 * dominate), keep the top MAX_SENTENCES, then restore their ORIGINAL document order so the
 * summary reads naturally. No LLM and no external API — only string math. Output matches the
 * content template's output schema { summary }.
 */
export const summarizeText = defineSkill({
  name: "summarize_text",
  description:
    "Produce a short deterministic extractive summary of the given text by selecting its most salient sentences (word-frequency salience, no LLM, no external API).",
  input: z.object({
    text: z.string().min(1),
  }),
  output: z.object({
    summary: z.string(),
  }),
  async run({ input }) {
    const sentences = splitSentences(input.text);
    if (sentences.length === 0) {
      // No sentence boundaries: the whole input is one unit, return it trimmed.
      return { summary: input.text.trim() };
    }
    if (sentences.length <= MAX_SENTENCES) {
      // Already short enough — nothing to extract, return the original text.
      return { summary: sentences.join(" ") };
    }

    // Salience model: frequency of each content word across the whole document.
    const freq = new Map<string, number>();
    for (const sentence of sentences) {
      for (const w of contentWords(sentence)) {
        freq.set(w, (freq.get(w) ?? 0) + 1);
      }
    }

    // Score each sentence by mean salience of its content words; pair with index to keep order.
    const scored = sentences.map((sentence, index) => {
      const words = contentWords(sentence);
      const total = words.reduce((sum, w) => sum + (freq.get(w) ?? 0), 0);
      const score = words.length > 0 ? total / words.length : 0;
      return { index, score };
    });

    // Pick the top MAX_SENTENCES by score; ties break toward the earlier sentence (stable order
    // via the original index) so the choice is deterministic.
    const ranked = [...scored].sort((a, b) => (b.score - a.score) || (a.index - b.index));
    const keep = ranked.slice(0, MAX_SENTENCES).map((s) => s.index);
    const keepSet = new Set(keep);

    // Restore document order so the summary reads as a coherent excerpt.
    const chosen = sentences.filter((_s, i) => keepSet.has(i));
    return { summary: chosen.join(" ") };
  },
});

export const textSummarizerAgent = defineAgent({
  name: "TextSummarizer",
  scoreless: true,
  bio: [
    "I write a short extractive summary of any text you give me and deliver it as a sealed job.",
    "I am a scoreless agent: you pay on delivery and trust the result — there is no scoring.",
  ],
  systemPrompt: [
    "You are TextSummarizer, a scoreless agent that sells ONE job: a short extractive summary of",
    "text the user provides. This is a content job; you do not forecast, trade, or evaluate anything.",
    "Rules you MUST follow:",
    "- You only summarize text. Politely decline requests outside that field (predictions, prices,",
    "  trading, code, and the like).",
    "- This is a SCORELESS job: there is no asset and no lifetime/scoring window. Do not ask for an",
    "  asset or a time window.",
    "- The user must give you the text to summarize before you accept.",
    "- You charge a FLAT FEE of 10 QUADRA per summary. State this price whenever you discuss or",
    "  accept a job; never leave the price unstated.",
    "- You never write the summary yourself in chat — it is produced for you deterministically from",
    "  the user's text after the job is accepted, and delivered sealed.",
    "- As soon as the user has given you the text to summarize, ACCEPT the job in EXACTLY this",
    "  one-line form (keep it verbatim): 'Accepted: summary, price 10 QUADRA.'",
    "Keep replies short and concrete.",
  ].join("\n"),
  templateCategoryIds: ["content"],
  skills: [summarizeText],
});

export default textSummarizerAgent;
