// 2026-10-09 (round 15): what a table can be used for, read off its column
// names and types - the "Start from your data" ideas on ML Studio's home.
// Covers the newer kinds too (text, baskets, cohorts, spend, price, journeys).
import type { StudioTable } from "../api/mlStudio";

export type Idea = { type: string; label: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_");

const DATE_NAME = /(date|time|day|week|month|year|_at$|created|period|timestamp)/;
const DATE_TYPE = /(date|time)/i;
const NUM_TYPE = /(int|float|double|numeric|decimal|number|real|money|bigint)/i;
const OUTCOME = /(churn|cancel|^is_|^has_|status|converted|default|fraud|returned|left|active|won|lost|paid|outcome|result)/;
const TEXT = /(text|comment|review|message|body|description|feedback|note|subject|content|caption|transcript|reply|question|summary)/;
const ORDER = /(order|basket|invoice|transaction|receipt|cart)(_?id|_?no|_?number)?$/;
const ITEM = /(product|item|sku|article|title|variant)(_?id|_?name)?$/;
const PERSON = /(customer|client|user|member|buyer|account|person|guest|contact|email)(_?id)?$/;
const SPEND = /(spend|cost|budget|ad_?spend)/;
const SALES = /(revenue|sales|gmv|income|amount|total)/;
const PRICE = /(price|unit_price)/;
const UNITS = /(units|qty|quantity|volume)/;
const CHANNEL = /(channel|utm_source|utm_medium|medium|source|campaign|touchpoint)/;
const START = /(start|signup|signed_up|created|opened|joined|first)/;
const END = /(end|cancel|churn|closed|resolved|last|left|paid_at|due)/;
const DOC = /(document|invoice_text|contract|pdf|email_body|raw_text)/;

export function ideasFor(t: StudioTable): Idea[] {
  const cols = (t.columns || []).map((c) => ({ n: norm(c.name), t: c.type || "" }));
  const has = (re: RegExp) => cols.some((c) => re.test(c.n));
  const count = (re: RegExp) => cols.filter((c) => re.test(c.n)).length;
  const dates = cols.filter((c) => DATE_NAME.test(c.n) || DATE_TYPE.test(c.t));
  const hasDate = dates.length > 0;
  const nums = cols.filter((c) => NUM_TYPE.test(c.t)).length;
  const text = cols.some((c) => TEXT.test(c.n) && !NUM_TYPE.test(c.t));
  const out: Idea[] = [];
  const add = (type: string, label: string) => {
    if (!out.some((o) => o.type === type)) out.push({ type, label });
  };

  if (has(DOC)) add("doc_facts", "Pull facts from documents");
  if (text) {
    add("sentiment", "Sentiment");
    add("text_tag", "Sort and tag text");
    if (hasDate) add("themes", "Find themes by month");
  }
  if (has(ORDER) && has(ITEM)) add("bought_together", "Bought together");
  if (has(PERSON) && hasDate && (has(ORDER) || has(SALES))) add("cohorts", "Cohort retention");
  if (has(SPEND) && hasDate && has(SALES)) add("marketing_mix", "Spend → sales");
  if (has(PRICE) && has(UNITS) && has(ITEM)) add("price", "Price sensitivity");
  if (has(PERSON) && has(CHANNEL) && hasDate) add("attribution", "Channel credit");
  if (has(PERSON) && has(ITEM)) add("recommendations", "Recommend products");
  if (dates.some((d) => START.test(d.n)) && dates.some((d) => END.test(d.n))) add("time_to_event", "When it will happen");
  if (cols.some((c) => OUTCOME.test(c.n))) add("yes_no", "Predict an outcome");
  if (hasDate && nums) add("forecast_one", "Forecast");
  if (nums >= 2) add("segments", "Find segments");
  if (nums) add("anomalies", "Spot unusual rows");
  if (nums && count(SALES) > 0) add("drivers", "What drives a number");
  return out.slice(0, 4);
}

export const FILE_KINDS = new Set(["csv", "excel"]);
