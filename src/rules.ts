/**
 * Retrieval rules: language/intent tables and helpers for ranking. Pure data
 * + pure functions — no graph/build imports, so rules are unit-testable and
 * shared across lanes (lexical rank, doc gating, change intent).
 */

// common words carry no retrieval signal; matching code on them drowns real
// matches in hub files (natural-language doc queries especially)
export const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "is", "are", "was", "were", "be", "been", "being",
  "it", "its", "this", "that", "these", "those", "for", "with", "at", "from", "by", "as", "into", "onto",
  "how", "what", "when", "where", "why", "which", "who", "whom", "whose", "do", "does", "did", "we", "they",
  "you", "your", "i", "me", "my", "he", "she", "him", "her", "his", "their", "them", "us", "our", "itself",
  "will", "would", "can", "could", "should", "have", "has", "had", "not", "but", "so", "if", "then", "than",
  "too", "very", "just", "also", "all", "any", "some", "each", "every", "one", "two", "other", "another",
  "there", "here", "whereas", "whilst", "upon", "within", "without",
]);

// words that make a query explicitly about recent working-tree changes; when
// present, recent-change applies to every changed file regardless of topical
// affinity ("what did we change recently"). Without one, change is only a
// boost on top of a real match, never a ranking reason by itself.
export const RECENT_WORDS = new Set(["recent", "recently", "change", "changed", "changes", "modify", "modified", "edited", "edits", "editing", "touched", "uncommitted", "dirty"]);

// queries explicitly about tests/code defects: test-file hits keep their score;
// without one of these signals, test scaffolding must not outrank real code
export const TEST_INTENT = /(^|[\s"-])(test|spec|fix|bug|fails?|failing|broken|regress)/i;

// explicit history intent: gates the git co-change lane (never affects
// ordinary topical retrieval)
export const HISTORY_INTENT = /\b(why did|when did|history|regression|introduced(?: by)?|co-?changed)\b/i;

// negative constraints: explicit scope restrictions parsed from the task text.
// Applied as penalties before propagation, so excluded scopes never seed.
export const NEG_TESTS = /(?:not|no|excluding|without|ignore)\s+(?:the\s+)?(?:unit\s+)?tests?/i;
export const NEG_PRODUCTION = /\bproduction\b/i;
export const NEG_LEGACY = /without\s+(?:the\s+)?legacy/i;
export const ONLY_CONFIG = /\bonly\s+(?:the\s+)?config/i;
export const SCOPE_UNDER = /\bunder\s+([a-zA-Z0-9_./-]+)/i;

// a base (graph+lexical) hit at or above this score is a genuine lexical
// match (several distinct query terms in one symbol). Below it, the query is
// low-confidence and semantic results lead — UNLESS an authoritative low-score
// signal (recent-change, explicit-file) already pinned the answer.
export const WEAK_BASE_SCORE = 5;
export const AUTHORITATIVE_REASONS = ["explicit-file", "recent-change", "basename-match"];

// generic test framework scaffolding: evidence, not targets
export const GENERIC_TEST = new Set(["it", "test", "describe", "expect", "beforeeach", "aftereach", "beforeall", "afterall"]);

// queries asking for prose answers ("where is X documented"): the best
// matching doc may lead the ranking instead of sitting below the code
export const DOC_INTENT = /(documentation|docs?|guide|manual|reference|tutorial|readme)/i;

/** Test-file detection by path segment: tests/ dir, *_test.go, test_*.py,
 *  conftest.py, *.spec.*. "testing.py" (production code) is NOT a test file. */
export function isTestFile(file: string): boolean {
  return file.split("/").some(
    (seg) =>
      seg === "test" ||
      seg === "tests" ||
      seg === "spec" ||
      seg === "conftest.py" ||
      seg.startsWith("test_") ||
      seg.startsWith("spec_") ||
      seg.endsWith("_test") ||
      seg.includes("_test.") ||
      seg.includes(".spec.") ||
      seg.includes(".test."),
  );
}

// irregular morphology the porter stemmer misses ("kept" -> "keep"):
// query terms are expanded with their base forms, so "values are lost when
// it shuts down" can match a repo that says "lose". The vocabulary must
// exist in the repo — this bridges forms, never inventing terms.
const IRREGULAR_BASES: Record<string, string> = {
  kept: "keep", lost: "lose", losing: "lose", wrote: "write", writing: "write",
  ran: "run", running: "run", made: "make", making: "make", bought: "buy",
  built: "build", sent: "send", sending: "send", got: "get", getting: "get",
  found: "find", finding: "find", gave: "give", giving: "give", took: "take",
  taking: "take", came: "come", coming: "come", went: "go", going: "go",
  did: "do", doing: "do", had: "have", having: "have", was: "be", were: "be",
  been: "be", met: "meet", meant: "mean", knew: "know",
  knowing: "know", threw: "throw", thought: "think", taught: "teach",
  caught: "catch", brought: "bring", fought: "fight", sought: "seek",
  held: "hold", told: "tell", sold: "sell", spoke: "speak", broke: "break",
  chose: "choose", drove: "drive", fell: "fall", felt: "feel", forgot: "forget",
  grew: "grow", heard: "hear", hid: "hide", led: "lead",
  left: "leave", lent: "lend", paid: "pay", read: "read", rode: "ride",
  rang: "ring", rose: "rise", shook: "shake", shone: "shine", shot: "shoot",
  shut: "shut", sang: "sing", sank: "sink", sat: "sit", slept: "sleep",
  slid: "slide", spent: "spend", stood: "stand", stole: "steal", stuck: "stick",
  struck: "strike", swore: "swear", swam: "swim", swung: "swing",
  tore: "tear", wore: "wear", woke: "wake", won: "win", withdrew: "withdraw",
  signed: "sign", signs: "sign", signing: "sign", verified: "verify",
  verifies: "verify", cookies: "cookie", routes: "route", values: "value",
};

/** Expand a query term with its irregular base form when one exists. */
export function expandIrregular(term: string): string[] {
  const base = IRREGULAR_BASES[term];
  return base && base !== term ? [term, base] : [term];
}
