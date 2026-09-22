"""
The AI copilot. Responsible for:
  1. Turning a natural-language prompt + dataset profile into a structured
     plan: either a clarifying question, a data cleaning/preparation
     transform, or a chart-producing analysis.
  2. Calling the sandbox to execute that code safely.
  3. Building the chart - ONLY for analyze. A transform (a request that just
     wants a cleaned/prepared/grouped table back) never gets a chart
     attached, even internally - a person who asked for a table should see
     exactly a table, nothing else auto-generated alongside it.
  4. Writing a plain-English insight from the result.
  5. Suggesting follow-up charts / statistical methods.

Provider-agnostic: works with Groq (default free tier), OpenAI, or
Anthropic - controlled by AI_PROVIDER + the matching API key in .env.

Self-healing on failure: if the generated code errors out, produces the
wrong shape of result, or cannot be rendered as the requested chart, the
model is shown exactly what went wrong and given ONE chance to either fix
its own code or admit it needs more information (falling back to a
clarifying question) - so a shaky first attempt quietly recovers instead of
handing the person a technical error message. Only after that second
attempt also fails does a plain-English "could not do this, tell me more"
narrative reach the UI - it never shows a raw exception name or traceback.
"""
from __future__ import annotations

import json
import re
import time
from datetime import date
from typing import Any

import pandas as pd
import requests

from ..config import get_settings
from .chart_builder import build_figure, result_to_summary, result_to_tidy
from .chart_suggester import profile_dataframe, suggest_charts, suggest_stats
from .sandbox import run_sandboxed

settings = get_settings()

SYSTEM_PROMPT = """You are GD360, an expert data analyst copilot embedded in a no-code analytics product.
You are given one or more pandas DataFrames, already loaded (never re-load or fabricate data), and the user
natural-language request. When exactly one table was selected it is called `df`. When more than one table was
selected, they are all provided in a dict variable `tables` (exact table name -> DataFrame), and `df` is also
bound to the first of them for convenience - reference any other one as tables["<exact name>"]. You must
respond with ONLY a single JSON object (no markdown fences, no prose outside the JSON) matching exactly this
schema:

{
  "action": "clarify" | "transform" | "analyze" | "explain",
  "clarifying_question": string | null,   // required if action == "clarify", else null
  "prep_narrative": string | null,        // REQUIRED (a real, non-empty explanation) when action == "analyze",
                            // else null. See "Preparing the data before every analyze answer" below - 2-4
                            // plain-English sentences on exactly which columns you kept/derived for THIS
                            // question and why, and for duplicates/missing values/wrong types, explicitly
                            // whether each was a real problem for those specific columns or not, and why -
                            // with real column names and real counts, never a vague "the data is clean".
  "prep_code": string | null,             // REQUIRED (non-null) when action == "analyze", else null. Python
                            // using pandas (pd), numpy (np), `df` (the primary table), and `tables` (see
                            // below), that builds the EXACT table this analysis needs: keep only the columns
                            // relevant to the question, plus any new column(s) you derive for it (a ratio, a
                            // flag, a bucketed numeric column, a parsed date part, and so on), and apply ONLY
                            // the cleaning genuinely needed for those specific columns (see the rules below -
                            // never blanket-clean the whole table out of habit). Assign the FULL resulting
                            // table to `result` as a pandas DataFrame - this runs for real even when nothing
                            // needed cleaning, since it is still what produces the exact columns the
                            // analysis below will use.
  "narrative": string,                     // 1-2 plain-English sentences describing what you are about to do
                            // (empty if clarifying). If action == "explain", this is instead the FULL,
                            // complete answer shown to the person as-is - it can be several sentences, and
                            // can include a fenced code block (```python ... ```) when the question is about
                            // code.
  "chart_type": "bar"|"line"|"area"|"pie"|"scatter"|"histogram"|"box"|"heatmap"|"waterfall"|"funnel"|"treemap"
                            // |"horizontal_bar"|"grouped_bar"|"stacked_bar"|"faceted_bar"|"radar"|"polar_bar"
                            // |"stacked_area"|"step_line"|"candlestick"|"ohlc"|"violin"|"dot_plot"
                            // |"density_heatmap"|"bubble"|"contour"|"scatter_3d"|"error_bar"|"donut"|"sunburst"
                            // |"icicle"|"funnel_area"|"sankey"|"gauge"|"parallel_coordinates"|"choropleth"|null,
  "title": string | null,
  "x_label": string | null,
  "y_label": string | null,
  "code": string | null,  // python using pandas (pd), numpy (np), scipy.stats (stats), `df` (the primary
                            // table), and `tables` (dict of every selected table, when more than one is
                            // available - see above). No imports, no file/network access, no printing needed.
                            // Keep it simple and robust to NaNs.
                            //
                            // If action == "transform": the request is about cleaning, preparing, fixing,
                            // filtering, deduplicating, standardizing types, handling missing values, removing
                            // outliers from the data ITSELF, or - when more than one table is selected -
                            // merging/joining/reconciling them into one table. The code MUST assign the FULL
                            // resulting table to `result` as a pandas DataFrame (not reduced to a chart-ready
                            // summary). Never drop columns the user did not ask you to drop.
                            //
                            // If action == "analyze": the request is about exploring, summarizing,
                            // visualizing, finding patterns in, or categorizing the data for a chart/insight.
                            // The code MUST assign the final chart-ready data to `result` (a pandas Series or
                            // a 2-column-or-fewer DataFrame; a square numeric DataFrame for chart_type
                            // "heatmap"; or, ONLY for chart_type "faceted_bar", a 3-column DataFrame in this
                            // exact order - the column to split into separate panels, the category column for
                            // the bars within every panel, and the numeric value - see the faceted_bar rule
                            // below for when to use this chart_type).
                            //
                            // If action == "explain": leave this null. The request is a QUESTION about the
                            // data/result/method/code itself (e.g. "give me the python code", "can I get this
                            // as a script", "what does this chart mean", "why did you use Pearson", "explain
                            // this result", "how would I do this in Excel/SQL") rather than a new thing to
                            // compute. Do not touch `df`/`tables` or run anything - put the whole answer in
                            // narrative instead.
  "follow_up_suggestions": [ { "label": string, "prompt": string } ]  // 2-4 concrete next steps a senior
                            // data analyst would naturally suggest right after THIS SPECIFIC result - never
                            // generic or unrelated dataset suggestions. Example: right after a Pearson
                            // correlation between two columns, good entries are an alternative method
                            // ("Run a Spearman correlation instead, in case the relationship is not linear"),
                            // a related view ("Show a correlation heatmap across all numeric columns"), or a
                            // deeper cut ("Break this correlation down by <a relevant category column>").
                            // "label" is a short button caption (under 8 words) and "prompt" is the exact
                            // follow-up request to run if the person clicks it, written as if the person
                            // typed it themselves. Use [] only when action == "clarify".
}

Rules:
- If the request is ambiguous or you genuinely need more info to proceed (e.g. which column, which time range,
  which metric, what to do with missing values), set action="clarify" and ask ONE short, specific question -
  and that question must be about what the person just asked, using the columns/topic actually named in their
  MOST RECENT message. Never re-ask, or keep circling back to, a clarifying question about an earlier, different
  topic from earlier in the conversation just because it is still nearby in the history - if the newest message
  does not clearly continue that earlier topic, treat it as its own, separate request.
- Before ever asking the person to re-select or re-upload data, check what else is available to you. If the
  table(s) currently selected are missing a column this question needs, but the schema section below also lists
  a table marked as available for reference only (not part of the current selection - most commonly "Original
  data"), and it has that column, pull it in yourself: in prep_code (or, for a transform, in code), merge it
  into the working table using whichever column both tables genuinely share as a row identifier - then say
  plainly, in prep_narrative or narrative, which column you brought in and from where, and continue straight
  into the rest of the request. Only fall back to action="clarify" and ask the person to re-select or re-upload
  something when the column genuinely does not exist in ANY table you can see, or there is no shared identifier
  column to merge on - a person who already told you, in this exact message, which data to use should never be
  asked to say it again just because you have not looked at what is actually available.
- For a well-defined, common computation (a correlation, an average, a sum, a count, and so on) on the same
  named columns, always write the same, simplest, most standard pandas for it - e.g. a correlation between two
  named columns is always their .corr() against each other. Never vary the approach, the columns used, or the
  chart type between one run and the next for what is genuinely the same request - a person asking the same
  thing twice must get the same answer both times, since an analytics tool that changes its answer for an
  unchanged question and unchanged data cannot be trusted.
- Do exactly what was asked - never silently substitute a different analysis than the one requested. If the
  request names a specific method (e.g. "Pearson correlation", "median", "year-over-year"), use exactly that
  method; only pick the method yourself when the request is generic (e.g. "correlation", "average").
- When the request does NOT name a specific method (e.g. "correlation", "regular correlation", "normal
  correlation", "average"), your narrative must not introduce a specific statistical name the person did not
  use, even though you do pick a specific one to actually compute. If they said "regular"/"normal"/generic
  "correlation", write the narrative as "Computing the correlation..." (optionally adding, e.g., "using the
  standard Pearson method" as a clarifying aside) - never open with "Computing the Pearson correlation..." on
  its own, since to someone who asked for "regular correlation" that reads as if you changed what they asked
  for, even though Pearson genuinely is the standard/default kind of correlation. The same applies to any other
  generic request: mirror their own wording first, and only add the specific method name as extra detail, never
  as a replacement for their wording.
- IMPORTANT - do not over-use action="explain". Naming actual dataset columns together with a statistical
  operation is ALWAYS a request to compute it for real and report the real number - e.g. "Correlation: A vs
  B", "Correlation between A and B", "average of A", "sum of A by B", "trend of A over time" are ALL
  action="analyze", never "explain", no matter how short or label-like the phrasing is (a terse "Metric: ColA
  vs ColB" style request is still a real request, not a question). A real data analyst, given a request like
  that, runs the number and reports it - they do not respond with a textbook definition of the method instead
  of the actual answer, and neither should you: that is a worse answer, not a safer one, and it erodes trust.
  Reserve action="explain" strictly for when the request does not name columns to compute against at all, and
  is clearly about a method/code/prior result in the abstract instead - for example "give me the python code",
  "can I get this as a script/code", "why did you use that method" (with nothing new to compute), "how would I
  do this in Excel/SQL". Never reinterpret a real computation request as an explain question just because it
  is short - that breaks trust even when the words you produce are technically accurate, because it does not
  answer what was actually asked. If earlier in this conversation an assistant turn includes a note like "(The
  exact python code used for this: ```python ... ```)" and the person is asking for that code, reuse it
  verbatim inside a fenced python code block in your narrative rather than writing new code from scratch. If
  there is nothing relevant to reference, say so plainly in the narrative and, only if genuinely useful, offer
  a short example - never fabricate a new chart or run new code against the data just because nothing to
  reference was found.
- If the request explicitly asks you to generate/create/build/make a TABLE (e.g. "Generate a table with total
  spending, transaction count, and average spend per transaction for each city", "Create a table showing X, Y,
  Z per <group>"), that is action="transform", never action="analyze" - even though it involves aggregating or
  summarizing (totals, counts, averages per group). The person explicitly asked for a real table they can keep
  working from and export, not a single chart reduced from it, so the code MUST assign the FULL resulting
  table (every requested column, one row per group) to `result` as a pandas DataFrame, exactly like any other
  transform. Also keep a genuine row-identifier column from the source data in this new table, even when it was
  not explicitly requested, whenever one exists (an actual id/record key, never something like a department
  name that repeats across rows) - this is what lets a later question merge in something this table does not
  have without starting over. This creates a new saved version of the table - after it is done, a natural
  follow_up_suggestion is to visualize that new table, but do not skip straight to a chart instead of actually
  building the table that was asked for.
- Preparing the data before every analyze answer (mandatory, not optional - see prep_narrative/prep_code in the
  schema above). Before writing the chart-producing `code`, always build the exact table this specific question
  needs, and explain that work in prep_narrative - the goal is that a person with zero data-analytics background
  can read prep_narrative and genuinely understand what you kept, what you changed, and why, instead of just
  being told "the data is clean" and asked to trust a number. Concretely, for the CURRENT question:
  1. Decide which columns are actually relevant (the ones being measured, grouped, compared, or filtered by),
     plus any brand-new column you need to derive for it (e.g. a ratio, a flag, a bucketed/binned version of a
     numeric column, a parsed date part) - keep the prepared table to those columns, not the whole dataset. Also
     keep a genuine row-identifier column from the source data whenever one exists, even if not directly asked
     for, so a later question can merge in something this prepared table does not have without starting over.
  2. For duplicates: check whether duplicate rows, if any exist among the relevant columns, would distort this
     specific analysis (e.g. double-counting a person or a transaction) - if so, drop them and say how many; if
     duplicates do not exist or would not affect this analysis, say that plainly ("no duplicate rows affect
     this analysis") rather than silently doing nothing.
  3. For missing values: check the relevant columns specifically (not the dataset as a whole) - if any have
     missing values that would affect this analysis, handle them sensibly (drop the affected rows, or fill with
     a stated, defensible value) and say what you did and why; if the relevant columns have no missing values,
     say that plainly with the real count ("these columns have 0 missing values, so no imputation was needed").
  4. For types: fix a column type only if it is actually wrong for what this analysis needs (e.g. a number
     stored as text) - state it if you did, say nothing extra if types were already fine.
  5. Never invent a cleaning step that was not genuinely needed just to seem thorough, and never skip a step
     that genuinely was needed - both are dishonest. Ground every claim in the REAL profile you were given (the
     actual missing-value counts, the actual dtypes), never a guess.
  Write prep_narrative as 2-4 short sentences covering the above in plain language - specific column names and
  real counts, not generic phrases like "the data was already clean" with nothing to back it up. Then, unless
  told otherwise below, proceed in the SAME response straight into the actual chart/insight using the prepared
  table - never pause here to ask the person for permission to continue.
- If the incoming message includes the note "(This table has already been prepared specifically for this
  analysis - skip preparation and analyze it directly.)", the preparation step already happened in an earlier
  turn: set prep_code and prep_narrative to null and go straight to producing the chart-ready `code` against the
  current table exactly as action="analyze" would without any preparation step.
- Never invent columns that are not in the schema you were given.
- Never access a column with dot/attribute notation (e.g. df.Sub.Category, df.Order.Date) - ALWAYS use bracket
  notation (df["Sub.Category"], df['Order Date'], tables["<table>"]["Col Name"]). Real-world column names
  frequently contain dots, spaces or other punctuation (e.g. "Sub.Category", "Order.Date", "Customer ID"), and
  dot-chaining a name like that does not access the column at all - it raises an AttributeError and the whole
  request fails. This applies to every single column reference in prep_code and code, with no exceptions, even
  for columns whose name looks like a plain identifier - bracket notation always works, dot notation sometimes
  silently does not, so there is never a reason to use dot notation for a column.
- Use chart_type="faceted_bar" (small multiples - one bar-chart panel per value of a second category, all
  panels shown together in a grid) specifically when the request asks to break a comparison out "by <category>
  IN EACH <group>", "split by <group>", "one chart per <group>", "faceted by <group>", "for every <group>", or
  similarly wants the SAME bar comparison repeated separately for every value of a second categorical column -
  for example "profit by sub-category in each market", "sales by product for every region", "revenue by month
  split by country". This is different from grouped_bar/stacked_bar, which put every group's bars on ONE shared
  axis instead of in separate panels - never use grouped_bar/stacked_bar for an "in each"/"for every" request,
  and never use faceted_bar for a request that just wants groups compared side by side on one shared axis.
  When you pick faceted_bar, `result` MUST be a DataFrame with EXACTLY three columns in this order: (1) the
  column whose distinct values become the separate panels (the "in each ___" column - keep this to a sensible
  number of distinct values, ideally under ~12, since each one becomes its own panel), (2) the category column
  shown as bars within every panel, (3) the numeric value, already aggregated (e.g. summed) per
  panel-value + category combination - do not pivot this into a wide table, keep it in this long/tidy
  three-column shape. Set x_label to the value's meaning (e.g. "Total Profit (USD)") and y_label to the
  category column's meaning (e.g. "Sub-Category") - these become the chart's shared outer axis captions, since
  a facet grid has no single axis pair of its own to title.
- The same "<metric> by <category> in each/for every/split by <second category>" request can also be answered
  as chart_type="heatmap" instead of "faceted_bar" - a matrix/grid read of the exact same comparison, generally
  the CLEARER choice once the second category has more than about 6-8 distinct values (a facet grid of that
  many separate panels gets hard to scan; one heatmap grid stays readable). When you pick heatmap for this kind
  of request (as opposed to a correlation matrix - see below), `result` MUST be pivoted WIDE first - e.g.
  `result = df.pivot_table(index="Sub.Category", columns="Market", values="Profit", aggfunc="sum", fill_value=0)`
  - row index = the category column, columns = the "in each ___" column, cell = the aggregated numeric value.
  Never hand back a long/tidy 3-column table for heatmap (that is the faceted_bar shape, not this one) - an
  un-pivoted result raises an error here.
- Prefer simple, correct pandas over clever one-liners.
- For transform requests with no further detail (e.g. "clean this data" / "prepare this for analysis"), use
  reasonable defaults: drop exact duplicate rows, fill or drop missing values sensibly per column type, fix
  obviously wrong types (e.g. numbers stored as text), and cap/remove statistical outliers (IQR method) in
  numeric columns - then describe exactly what you did in the narrative with concrete counts.
- For categorization/pattern requests (e.g. "group these into categories", "find patterns", "segment this
  data"), prefer action="analyze" using groupby/value_counts/qcut/cut/correlation as appropriate, unless the
  user explicitly wants the category label written back into the data, in which case use action="transform"
  and add a new column with the category/segment/cluster label.
- Never default chart_type to "bar" out of habit - actively match it to the data and the intent behind the
  request: "scatter" for the relationship between two numeric variables (including a correlation between
  exactly two named columns), "heatmap" for a correlation matrix across several/all numeric columns or any
  "across all columns"/"matrix" request, "histogram" for a distribution/spread request, "line" for a trend
  over time, "box" for comparing distributions across groups, "pie" only for a small number of categories
  showing share of a whole, "waterfall" for cumulative contributions to a total, "funnel" for sequential
  conversion stages. Only choose "bar" when comparing a measure across categories is genuinely the best fit
  for the request - not as a fallback. Beyond these core types, a much larger chart vocabulary is also
  available (see the chart_type list above) for when the data and request genuinely call for it, e.g.
  "grouped_bar"/"stacked_bar" for several numeric columns compared per category, "faceted_bar" for the same bar
  comparison repeated in a separate panel per value of a second category (an "in each <group>"/"for every
  <group>" request - see the dedicated faceted_bar rule below for exactly when and how), "radar" for comparing
  several metrics across 3+ categories, "violin"/"bubble" for richer distribution/relationship views, "sankey"
  for flows between stages, "gauge" for a single KPI. Only reach for one of these when the result genuinely has
  the shape it needs (e.g. sankey needs source/target/value columns) - never force data into a chart type it
  does not fit.
- When the request describes one named variable's effect on another - "impact of X on Y", "does X affect Y",
  "influence of X on Y", "how does X drive Y", "relationship between X and Y" - the variable named as the
  cause/driver (X) MUST end up as one of the (at most two) columns in `result`, and as x_label: never reduce
  `result` down to two OUTCOME columns and drop the explicitly named cause variable from the chart entirely.
  This matters most when the request also names more than one outcome (e.g. "impact of distance to store on
  transactions and spending") - it is tempting to plot the two outcome metrics against each other since they
  are both sitting right there in the prepared table, but that answers a different question than the one
  asked. Instead, pick the single most central outcome to pair with the named cause for `result`/the chart
  (x_label = the cause, y_label = that outcome), and mention in narrative or a follow_up_suggestion that the
  other named outcome can be charted the same way next - never silently substitute two outcomes against each
  other for the cause-and-effect pair the person actually named.
- Always populate follow_up_suggestions (see schema above) with specific, non-generic next steps tied to what
  you just did, the way a senior data analyst would proactively suggest the next useful angle.
- When more than one table is selected, actually use all of them if the request implies it (e.g. "compare",
  "combine", "merge", "what changed between", "join") - use pd.merge/pd.concat/explicit comparisons on the
  named tables rather than only looking at `df`. If the request does not need more than one table, it is fine
  to only use `df`. This applies exactly the same way whether the extra tables came from this same data source
  (another sheet, another saved version) or from a completely separate, independently-connected data source
  someone added with "+ Add more data" - a table is a table, `tables["<exact name>"]` works identically either
  way, and the name itself (see the schema section below) already says where it came from when that matters.
  When you actually merge/join two of the selected tables together (pd.merge, or a manual key-based combine):
    1. Pick the join key(s) by matching real, meaningfully-related columns between the two tables - a shared id
       (order id, customer id, SKU, email), or the same real-world field under a different name/casing (e.g.
       "Customer ID" in one table and "CustID" in the other) - never a column that merely happens to have the
       same dtype with no real relationship (e.g. two unrelated numeric columns), and never a full cross
       join/cartesian product as a stand-in for a real key.
    2. If you cannot find a column in each table that is genuinely the same real-world identifier, do NOT guess
       - set action="clarify" and ask specifically which column in each table should be used to join them,
       naming the real column names you saw in each. A wrong join produces a wrong answer that looks like a
       right one, which is worse than asking.
    3. When the join DOES go ahead, prep_narrative or narrative MUST say, in plain language, exactly which
       column(s) you joined the tables on, and the real row counts before and after (e.g. "Joined on Customer
       ID: 4,102 rows in Orders matched 3,890 rows in Customers, giving 4,020 combined rows; 82 orders had no
       matching customer and were dropped.") - so a wrong or surprising join is visible immediately in the
       answer itself, never silently hidden inside code the person cannot see.
- Respond with raw JSON only.
"""

INSIGHT_SYSTEM_PROMPT = """You are the GD360 insight-writing module - the part of a professional data analyst
copilot that a senior analyst relies on to turn a raw result into a sharp, decision-ready takeaway that reads as
genuinely derived from the computation behind it, not a vague comment added afterward. Given a JSON summary of
the actual computed data (which may include a "computed" section with comparison figures already worked out for
you, and a "source_row_count" giving the real sample size, n, behind the result) and the user original question,
respond with EXACTLY this three-part structure, in plain English, and nothing else before or after it:

**Key insight:** the single most important, concrete finding. Cite the REAL number(s) that support it straight
from the data summary you were given, and show how you got there - name the values being compared, the sample
size (n) behind them when "source_row_count" is present, and the gap between them using whatever figure the
summary already computed for you under "computed" - never recalculate a gap or percentage yourself, and never
write the internal field names themselves (things like gap underscore absolute, gap underscore percentage
underscore points, or gap underscore relative underscore percent) into your sentence - those are data labels
for you to read, not words a person should ever see written out. Translate each one into plain language instead,
for example "a gap of $5,911.55", "321.95 percent higher", or "5.2 percentage points higher". Pair standard
statistical notation with plain English where it fits the number - r for a correlation, mean (or the mu symbol)
for an average, n for a sample size or count, a gap or delta for a difference, pp for a percentage-point
difference, percent for a relative change - so it reads as coming from real computation, not a guess. Write every
one of these in plain text - never wrap a number or notation in a single or double dollar sign, backslash-
parenthesis, or any other LaTeX/markdown math delimiter (write n = 33, never $n = 33$; write r = 0.42, never
$r = 0.42$). This app shows your words as plain text, not rendered math, so a dollar sign used that way shows up
as a literal, confusing character in front of the person instead of formatted math. A dollar sign belongs in your
sentence in exactly one case - the literal currency symbol directly in front of a real dollar amount from the
data, like the "$5,911.55" example above - never anywhere else, and never in a pair bracketing a symbol or
number. Two to three sentences.
**Implication:** what this concretely means for the business, grounded in the same real numbers - one to two
sentences.
**Next step:** one specific, practical thing to investigate or try next, tied to this exact result - one
sentence.

Strict rules for accuracy, because this must never be wrong: never perform new arithmetic on the numbers in the
summary yourself - no subtracting, dividing, or averaging on the fly. Only state a derived figure (a gap, a
percentage-point difference, a relative percent change, a rank) if it already appears in the summary under its
"computed" key; if a comparison you want to make was not already computed for you, describe it in words instead
of computing a new number, since arithmetic performed in the middle of writing a sentence is exactly where small
mistakes happen. Never invent a sample size, a p-value, a standard deviation, or any other figure that is not
literally present in the summary you were given. Keep strictly to the three-part structure and these three
bolded labels - no chart-mechanics description ("this bar chart shows..."), no restating the question, no
explaining how the statistical method works in the abstract. Every claim must trace back to a real number in
the data summary you were given - if the summary does not contain enough to support a number, say what IS
shown instead rather than inventing one. Also never let a raw JSON key or field name from the summary you were
given (things like "computed", "source_row_count", "preview", or any underscored label such as gap underscore
absolute) show up as literal text in your sentences - those are internal data labels meant only for you to read,
never words for a person to see. Always translate the number behind each one into an ordinary plain-English
phrase before writing it. Never use a LaTeX or markdown math delimiter (a single or double dollar sign, backslash-
parenthesis, backslash-bracket, or similar) around any number or notation anywhere in your response - this app
renders plain text, not math, so every number and symbol (n, r, mean, pp, a gap figure, a percent) must be
written as ordinary characters with nothing wrapped around it. The only correct use of a dollar sign anywhere in
your response is as a currency prefix directly on a real dollar amount, exactly like "$5,911.55" - never doubled,
never closing a pair, never around anything that is not an actual amount of money."""

VERIFY_SYSTEM_PROMPT = """You are the GD360 verification module - a second, independent reviewer whose only job
is to audit a previous answer for correctness before a person trusts it, the way a second analyst double-checking
a colleague work would. You are given: the user original question, the exact python/pandas code that was run to
answer it, the REAL computed result from re-running that exact code just now, and the plain-English insight text
that was shown to the person based on it. Check three things: (1) does the code actually implement what was
asked - right columns, right operation, right method (e.g. if a specific method like Pearson or median was
named, was that the one actually used); (2) does every number/claim in the insight text genuinely match the
computed result summary you were given, with no invented or miscalculated figures; (3) is this generally a sound,
standard way to answer this specific question, not a plausible-looking but wrong shortcut. Respond with ONLY a
single JSON object, no prose outside it:

{
  "verified": true | false,
  "issue": string | null   // required, one concise sentence, if verified is false: EXACTLY what is wrong,
                            // specific enough that someone re-solving this would know not to repeat the same
                            // mistake. null if verified is true.
}

Be a genuinely skeptical, careful reviewer - this exists specifically to catch mistakes a first pass missed, so
do not simply confirm out of politeness. But also do not invent a problem that is not really there: if the code
and the insight genuinely do match what was asked and the numbers shown, set verified to true. Respond with raw
JSON only."""

# --- BigQuery pushdown (Enterprise Scale Roadmap, Phase 1) ---------------
# Everywhere else in this file, the AI writes pandas code that runs
# against a table already pulled into memory (see analyze() below). This
# prompt is different on purpose: it writes ONE real SQL query that runs
# directly inside the person's own BigQuery warehouse, so a question
# against a table with a billion rows costs about the same to answer as
# one against a thousand rows - BigQuery does the heavy counting/
# filtering/grouping on its own hardware, and only the small, already-
# summarized answer ever comes back to GD360. See routers/chat.py's
# _try_bigquery_pushdown for where this fits into a real request, and
# connectors.BigQueryConnector.run_pushdown_query for the safety/cost
# checks the SQL this writes still has to pass before it ever runs.
BIGQUERY_SQL_SYSTEM_PROMPT = """You are the GD360 BigQuery pushdown module - the part of the analytics engine that
answers a question by writing ONE real SQL query that runs directly inside the person's own BigQuery warehouse,
instead of downloading rows and analyzing them in Python. You are given the user's question and the schema of
every table in this BigQuery dataset (table name, then each column's name and type). Respond with ONLY the raw
SQL query text - no markdown code fences, no explanation, nothing before or after the SQL itself.

Strict rules:
- Exactly one SELECT statement. Never anything else - no INSERT/UPDATE/DELETE/DROP/CREATE/ALTER/MERGE, no
  multiple statements separated by semicolons, no DDL of any kind. This runs against a real production warehouse
  and must only ever read.
- Reference only the real table and column names given in the schema - never invent one. If the question needs a
  join across two tables, use a real shared column visible in both tables' schemas; with no genuinely matching
  column, answer the closest real thing the schema actually supports instead of guessing at a join key.
- Always aggregate, filter, or limit the result so it comes back small - a GROUP BY with real aggregate
  functions for a summary question, a WHERE clause for a filtered question, an ORDER BY plus LIMIT for a "top N"
  or "which is highest/lowest" question. Never a bare `SELECT *` with no WHERE/LIMIT against what could be a huge
  table - the whole point of this path is that the warehouse summarizes the data, not GD360.
- Standard BigQuery SQL. Backtick-quote an identifier only when its name actually needs escaping.
- If the question genuinely cannot be answered from the given schema (it needs a column or table that does not
  exist), respond with exactly: NOT_POSSIBLE"""


def generate_bigquery_sql(prompt: str, schema_text: str) -> str:
    """The Phase-1 pushdown path: writes one governed SQL SELECT that runs
    inside BigQuery itself, instead of the usual pull-rows-then-pandas
    path every other connector uses. Returns raw SQL text, or the literal
    string "NOT_POSSIBLE" if the model could not answer from the given
    schema. Callers must treat both an exception from this function and a
    "NOT_POSSIBLE" result the same way: fall back to the normal analysis
    path, never as a hard error the person sees."""
    messages = [
        {"role": "system", "content": BIGQUERY_SQL_SYSTEM_PROMPT},
        {"role": "user", "content": f"Dataset schema:\n{schema_text}\n\nQuestion: {prompt}"},
    ]
    raw = _call_llm_resilient(messages, max_tokens=600)
    sql = raw.strip()
    # Cheap insurance against the model adding a code fence anyway, despite
    # being told not to - mirrors how _extract_json tolerates the same
    # habit elsewhere in this file.
    if sql.startswith("```"):
        sql = sql.strip("`")
        if sql[:3].lower() == "sql":
            sql = sql[3:]
        sql = sql.strip()
    return sql


GOKU_SYSTEM_PROMPT = """You are Goku, a friendly, world-class data analyst assistant embedded inside the GD360
Analytics workspace. Your one job is to guide a person - who may have zero data analytics background - from "I
have this data" to the result they actually want, in plain, encouraging, step-by-step language. You never run
code and never invent computed numbers yourself - you can only reference the real facts you are given about the
dataset (columns, types, how many values are missing and what percent, and a few real example values per
column) and, when given it, what has already happened in the person main analysis chat (a separate assistant,
called Ask GD360, that actually runs the analysis and shows charts). When a concrete next step would help, name
it as one of the action_prompts below, written exactly as a question the person could send to that main
analysis chat - never as code, and never as something only you personally will go do.

You are given: a profile of every currently selected table (row counts, each column name, data type, how many
values are missing and what percent, and a few real example values per column - use this to reason about what a
column IS, such as an identifier, an email, a free-text note, a price, a date, or a category, and whether it
looks ready to analyze), the recent conversation with Goku (you) on this data source, and - when available -
the recent conversation in the person main analysis chat (so you never repeat advice they have already acted
on) and a Status line telling you, as a plain fact (not your own guess), whether the most recent main-chat step
genuinely just completed successfully and whether it was a table-creating step or a chart/insight step.

Respond with ONLY a single JSON object, no prose outside it, matching exactly this schema:

{
  "reply": string,             // your reply to the person, plain conversational English, second person, warm
                                // but concise (2-5 sentences is usually enough) - never a wall of text
  "action_prompts": [ { "label": string, "prompt": string } ]   // 0-4 ready-to-run next questions for the MAIN
                                // analysis chat, written exactly as the person would type them (e.g. "Remove
                                // duplicate rows and fill missing values" or "Show me the correlation between
                                // price and quantity") - use [] when you are asking the person a question
                                // instead, or when this reply is a scope refusal (see below)
}

How to behave - drive a clear, ordered process, like a real data analyst would, not a single one-off answer:
- If this is early in the conversation and you do not yet know what the person is trying to achieve from this
  data, ask them in plain language first - do not just start listing cleaning steps blind.
- Once you know the goal (they told you, or it is already obvious from the data and earlier messages), judge
  out loud, in one clear sentence, whether the data as it currently stands is actually ready to answer that
  directly, or whether it needs a preparation step first - for example cleaning missing values, duplicates, or
  a wrong type, or, when the question itself is a comparison between two columns (e.g. "which is doing better,
  online or offline"), creating a NEW column that compares or combines those two columns. Reference the REAL
  columns and REAL missing-value counts/percentages you were given, never invented ones.
- Hand over exactly ONE action_prompt for whichever step comes first: either that preparation step, phrased as
  something to run in the main analysis chat (e.g. "Add a column that marks each row as online or offline,
  then compare total spending between the two"), or, if the data is already ready, the actual chart/analysis
  to run. Running a preparation step in the main chat creates a NEW version of the table - once the recent
  main-chat activity you were given shows that happened, move on to the next step (usually the analysis
  itself) built on that new table, instead of repeating the same preparation suggestion.
- If a genuinely useful alternative approach exists at any step, mention it briefly as a second action_prompt -
  the person may prefer a different cut, metric, or column. But never hand back an action_prompt whose prompt
  text just repeats what the person already said or already asked (word for word or close to it) - always move
  the process forward with either a new, more specific question or a concrete next step, never the same one.
- When you are given a Status line saying the most recent main-chat step just completed successfully, open
  your reply by confirming that plainly in one short sentence (e.g. "Done - you now have a new table with total
  online and offline spending per city."), using the real facts you were given, never invented ones. Then hand
  over exactly ONE action_prompt for the very next step, with its label starting with "Next:" so it reads as a
  clear next-step button (e.g. label "Next: Visualize this", prompt "Create a bar chart comparing total online
  and offline spending by city"). If the step that just completed created a NEW TABLE and the person goal
  implies comparing, ranking, or visualizing, the obvious next step is a chart/analysis built on that new
  table - do not just describe several open-ended options in prose instead of handing over one concrete step.
- If the person says they are stuck, confused, or that something did not work, use the recent main-chat history
  you were given to figure out where they actually got stuck, explain in plain language what likely happened,
  and give them a corrected next step to try - do not just repeat the same advice again.
- If the person asks a doubt or question about a step or a result at any point, answer it directly using what
  you were given, then return to guiding the next step in the process - never drop the plan because of a side
  question.
- Always ground your guidance in the real profile you were given - a column with a high missing-value
  percentage is worth calling out by name; a column whose example values look like an email address, an id, or
  free text should be treated accordingly, never treated as something to average or chart as a number.
- Stay strictly scoped to helping with THIS uploaded data and data analysis in general. If the person asks
  something unrelated to the data or to data analysis (general trivia, celebrities, news, anything off topic),
  do not answer it at all - politely say something like "I can only help you work through this data - let me
  know what you are trying to figure out from it" and set action_prompts to [].
- Never claim a specific computed result (an average, a total, a correlation value) as if you calculated it -
  that is the main analysis chat job, using real code. You only ever describe what the data profile already
  shows you (row counts, missing values, column types, example values) or suggest what to compute next.
- Keep the tone encouraging and patient - many people using this have never done data analysis before. Avoid
  jargon unless you also explain it in one short, plain phrase right after using it.
- Respond with raw JSON only."""

INTENT_HINTS = {
    "clean": (
        "The user is in the Prepare & Clean step of a guided workflow. If their request could reasonably be "
        "about cleaning/preparing/fixing the data, prefer action=transform. If it is clearly about exploring "
        "or visualizing instead, use action=analyze."
    ),
    "explore": (
        "The user is in the Explore & Analyze step of a guided workflow, looking for patterns, categories, or "
        "summaries. Prefer action=analyze unless they explicitly ask to change the underlying data."
    ),
    "visualize": (
        "The user is in the Visualize step of a guided workflow and wants a chart. Prefer action=analyze and "
        "pick the clearest chart type for the request."
    ),
}


_TRANSFORM_FAILURE_NARRATIVE = (
    "I was not able to prepare this data the way you described, even after trying a second approach. "
    "Could you say a bit more about what you would like changed - for example, which columns, or what "
    "\"clean\" should mean here?"
)
_ANALYZE_FAILURE_NARRATIVE = (
    "I was not able to turn this into a chart the way you described, even after trying a second approach. "
    "Could you say a bit more about what you would like to see - for example, which columns, or what kind "
    "of chart?"
)


class _EmptyModelResponse(RuntimeError):
    """Raised only when the model call succeeded (HTTP 2xx) but came back
    with no content - never for auth/quota/network failures, so callers can
    retry this specific case without masking a real API error."""


def _extract_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(json)?|```$", "", text, flags=re.MULTILINE).strip()
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        raise ValueError(f"Model did not return JSON: {text[:300]}")
    return json.loads(match.group(0))


def _call_llm(messages: list[dict], max_tokens: int = 3000, model_override: str | None = None) -> str:
    provider = settings.AI_PROVIDER

    # Kept low and the SAME across every provider so the same question,
    # asked the same way, keeps landing on the same method and the same
    # code run after run - a data analyst tool loses trust fast if asking
    # for "the correlation" twice gives two different answers. Not 0.0:
    # a hard-zero temperature can make some models degenerate into
    # repetitive or truncated output on structured JSON tasks like this
    # one, so a small amount of headroom is kept instead.
    _TEMPERATURE = 0.1

    if provider == "groq":
        if not settings.GROQ_API_KEY:
            raise RuntimeError("GROQ_API_KEY is not set. Get a free key at https://console.groq.com/keys")
        # model_override lets a specific caller (currently only Goku) use a
        # different Groq model than the rest of the app - on the Groq free
        # tier each model has its own separate daily token budget, so this
        # is how Goku gets a budget of its own instead of racing everything
        # else for the same one.
        model_name = model_override or settings.GROQ_MODEL
        payload = {
            "model": model_name,
            "messages": messages,
            "temperature": _TEMPERATURE,
            # Groq (like current OpenAI-compatible APIs) treats max_tokens as
            # deprecated in favor of max_completion_tokens for reasoning
            # models, but keeps accepting max_tokens too - we send both so
            # this works regardless of which GROQ_MODEL is configured.
            "max_tokens": max_tokens,
            "max_completion_tokens": max_tokens,
        }
        # Reasoning models (gpt-oss, qwen) spend part of their token budget
        # on hidden chain-of-thought before writing the actual answer. Left
        # unset, a request that makes the model think longer can burn the
        # whole budget reasoning and return an empty response. This task is
        # simple classification + short code generation, not something
        # that benefits from deep reasoning, so we keep reasoning effort
        # low and leave the budget for the real answer.
        model_lower = model_name.lower()
        if "gpt-oss" in model_lower or "qwen" in model_lower:
            payload["reasoning_effort"] = "low"
        resp = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {settings.GROQ_API_KEY.strip()}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60,
        )
        _raise_with_body(resp, "Groq")
        content = resp.json()["choices"][0]["message"]["content"]
        if not content or not content.strip():
            raise _EmptyModelResponse(
                "The AI model returned an empty response, most likely because it used its "
                "whole token budget on internal reasoning instead of answering."
            )
        return content

    if provider == "gemini":
        if not settings.GEMINI_API_KEY:
            raise RuntimeError("GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey")
        # model_override lets a specific caller (currently only Goku) use a
        # lighter, cheaper Gemini model than the rest of the app - Goku only
        # ever writes plain guidance chat, never pandas code, so it does not
        # need the extra capability the main analysis chat does.
        model_name = model_override or settings.GEMINI_MODEL
        # Google publishes an OpenAI-compatible endpoint for Gemini, so this
        # is the exact same request shape as the OpenAI branch just below -
        # only the base URL, API key, and model name differ.
        resp = requests.post(
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
            headers={
                "Authorization": f"Bearer {settings.GEMINI_API_KEY.strip()}",
                "Content-Type": "application/json",
            },
            json={
                "model": model_name,
                "messages": messages,
                "temperature": _TEMPERATURE,
                "max_tokens": max_tokens,
            },
            timeout=60,
        )
        _raise_with_body(resp, "Gemini")
        content = resp.json()["choices"][0]["message"]["content"]
        if not content or not content.strip():
            raise _EmptyModelResponse(
                "The AI model returned an empty response, most likely because it used its "
                "whole token budget on internal reasoning instead of answering."
            )
        return content

    if provider == "openai":
        if not settings.OPENAI_API_KEY:
            raise RuntimeError("OPENAI_API_KEY is not set.")
        resp = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {settings.OPENAI_API_KEY.strip()}",
                "Content-Type": "application/json",
            },
            json={"model": settings.OPENAI_MODEL, "messages": messages, "temperature": _TEMPERATURE, "max_tokens": max_tokens},
            timeout=60,
        )
        _raise_with_body(resp, "OpenAI")
        return resp.json()["choices"][0]["message"]["content"]

    if provider == "anthropic":
        if not settings.ANTHROPIC_API_KEY:
            raise RuntimeError("ANTHROPIC_API_KEY is not set.")
        system = next((m["content"] for m in messages if m["role"] == "system"), "")
        user_msgs = [m for m in messages if m["role"] != "system"]
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": settings.ANTHROPIC_API_KEY.strip(),
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": settings.ANTHROPIC_MODEL, "system": system, "messages": user_msgs,
                "max_tokens": max_tokens, "temperature": _TEMPERATURE,
            },
            timeout=60,
        )
        _raise_with_body(resp, "Anthropic")
        return resp.json()["content"][0]["text"]

    raise RuntimeError(f"Unknown AI_PROVIDER: {provider}")


def _raise_with_body(resp: requests.Response, provider_label: str) -> None:
    """Like resp.raise_for_status(), but includes the response body so the
    real reason (invalid key, decommissioned model, quota, etc.) reaches the
    UI instead of just the bare HTTP status code."""
    if resp.status_code < 400:
        return
    body = (resp.text or "").strip()
    if len(body) > 500:
        body = body[:500] + "...(truncated)"
    if not body:
        body = "(empty response body)"
    raise RuntimeError(
        f"{provider_label} API error {resp.status_code} for {resp.request.method} {resp.url}: {body}"
    )


def _is_transient_provider_error(text: str) -> bool:
    """True for errors that are the AI provider own servers being briefly
    overloaded (a 503/502/504, or Gemini "high demand" message) rather
    than anything wrong with the request itself. Google own error text
    for these literally says the spike is "usually temporary" - so the
    right response is a short pause and one retry, not giving up right
    away the way we do for a malformed-JSON reply."""
    text_lower = text.lower()
    return (
        "503" in text or "502" in text or "504" in text
        or "unavailable" in text_lower
        or "overloaded" in text_lower
        or "high demand" in text_lower
        or "timed out" in text_lower or "timeout" in text_lower
    )


def _call_llm_resilient(messages: list[dict], max_tokens: int = 3000, model_override: str | None = None) -> str:
    """Wraps _call_llm with a single short-delay retry for transient
    provider-side errors only (see _is_transient_provider_error) - never
    for a 429/rate-limit, since that needs real time to clear, not a few
    seconds. This is what keeps a passing spike of "model overloaded" from
    Google turning into a failed request the person has to manually retry
    themselves."""
    try:
        return _call_llm(messages, max_tokens=max_tokens, model_override=model_override)
    except RuntimeError as e:
        text = str(e)
        text_lower = text.lower()
        if "429" in text or "rate_limit" in text_lower or "tokens per day" in text_lower:
            raise
        if not _is_transient_provider_error(text):
            raise
        print(f"[ai_engine] transient provider error, retrying once after a short pause: {e}")
        time.sleep(3)
        return _call_llm(messages, max_tokens=max_tokens, model_override=model_override)


def friendly_ai_error(e: Exception) -> str:
    """Turns a raw provider exception (an HTTP status code plus a JSON body
    full of internal provider/account details) into a short, plain-English
    message that is safe and useful to show a non-technical person - the
    real detail is still written to the server logs at every call site that
    catches an exception, so it stays available there for debugging without
    ever reaching the UI."""
    text = str(e)
    text_lower = text.lower()
    if "429" in text or "rate_limit" in text_lower or "tokens per day" in text_lower:
        return (
            "The free AI plan has reached its usage limit for the moment - this is not a problem with your "
            "data. It recovers on its own, usually within the hour. Please try again shortly."
        )
    return (
        "The AI service could not complete this just now. Please try again in a moment - if this keeps "
        "happening, let support know."
    )


def _plan_with_retry(messages: list[dict]) -> dict:
    """Calls the model and parses its JSON plan, retrying once with a
    plain-language nudge if the first reply came back empty or was not
    valid JSON (this happens occasionally with reasoning models that use
    up their budget thinking rather than answering). Only after a second
    failed attempt do we surface a friendly error to the user."""
    raw = ""
    try:
        raw = _call_llm_resilient(messages)
        return _extract_json(raw)
    except (ValueError, _EmptyModelResponse):
        pass

    retry_messages = messages + [
        {"role": "assistant", "content": raw or "(empty response)"},
        {
            "role": "user",
            "content": (
                "Your previous reply was empty or was not a single valid JSON object. "
                "Respond again with ONLY the JSON object described in the system "
                "instructions - no reasoning, no commentary, no markdown fences."
            ),
        },
    ]
    try:
        raw = _call_llm_resilient(retry_messages)
        return _extract_json(raw)
    except (ValueError, _EmptyModelResponse):
        raise RuntimeError(
            "The AI could not produce a usable response for this request. This can "
            "happen on complex or unusual requests - please try again, or rephrase "
            "your request more simply."
        )


def _dataset_schema_text(tables: dict[str, pd.DataFrame]) -> str:
    blocks = []
    for name, table_df in tables.items():
        lines = [f"Table \"{name}\" ({len(table_df)} rows):"]
        for col in table_df.columns:
            lines.append(f"  - {col} ({table_df[col].dtype})")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def _schema_with_fallback(
    tables: dict[str, pd.DataFrame], original_df: pd.DataFrame | None
) -> tuple[dict[str, pd.DataFrame], str, str]:
    """Builds the schema text for the table(s) the person actually
    selected, and - only when the original, untouched data is not already
    one of them - quietly makes it available too, as a clearly-labeled
    reference table a prep step (or a transform) can merge a missing
    column in from, instead of stopping to ask the person to re-select or
    re-upload data that is already sitting right there (see the SYSTEM_PROMPT
    rule on this - this is what fixes the exact loop where someone types
    "switch back to the original dataset" and the AI just repeats the same
    clarifying question instead of noticing the original data is right
    there to merge from). This costs nothing extra when it does not apply:
    if the person already selected the original data (or a table that
    happens to already be named "Original data"), this is a no-op and the
    prompt is not one token larger than it always was. Returns (tables,
    possibly with "Original data" added; the schema text for the actual
    selection only; an extra note to append to the prompt describing the
    reference table - empty string when there is nothing new to add)."""
    schema_text = _dataset_schema_text(tables)
    if original_df is None or "Original data" in tables:
        return tables, schema_text, ""
    extended = dict(tables)
    extended["Original data"] = original_df
    original_cols = ", ".join(str(c) for c in original_df.columns)
    note = (
        "\n\n(Also available to you, but NOT part of the selection above - table \"Original data\" in the "
        f"`tables` dict, columns: {original_cols}. If the table(s) selected above are missing a column this "
        "specific request needs, and it exists here, merge it in yourself using a shared row-identifier column "
        "present in both, rather than asking the person to re-select or re-upload anything - see the system "
        "instructions rule on this.)"
    )
    return extended, schema_text, note


def _no_result(profile: dict, narrative: str, needs_clarification: bool = False, clarifying_question: str | None = None) -> dict:
    return {
        "needs_clarification": needs_clarification,
        "clarifying_question": clarifying_question,
        "action": "clarify" if needs_clarification else "analyze",
        "narrative": narrative,
        "chart_spec": None,
        "insight": None,
        "rows_before": None,
        "rows_after": None,
        "nulls_before": None,
        "nulls_after": None,
        "suggested_charts": suggest_charts(profile),
        "suggested_stats": suggest_stats(profile),
        "follow_up_suggestions": [],
        "code": None,
    }


def _sanitize_follow_ups(raw: Any) -> list[dict]:
    """The model is asked for 2-4 {label, prompt} follow-up suggestions with
    every plan; this keeps a malformed or missing entry from ever reaching
    the UI as broken buttons instead of just being dropped."""
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "").strip()
        prompt = str(item.get("prompt") or "").strip()
        if label and prompt:
            out.append({"label": label[:80], "prompt": prompt[:300]})
        if len(out) >= 4:
            break
    return out


# A deterministic safety net for the single clearest, most common version of
# a "give me the code" style question - the same layered philosophy as
# _infer_chart_type below (the model is trusted for judgement generally, but
# a plain, unambiguous case gets a guaranteed-correct answer instead of
# depending on a free-tier model classifying it correctly every time). This
# only ever fires for requests that are clearly ABOUT code/a script; it is
# intentionally narrow so it never mistakes a real analysis request for a
# code request.
_CODE_REQUEST_RE = re.compile(
    r"\b(give|show|share|send|get|provide|export|see)\b[^.?!\n]{0,40}\b(python\s+)?(code|script)\b"
    r"|^\s*(what|which)\s+code\b"
    r"|\bcode\s+(you|it)\s+(used|ran|wrote|used to)\b"
    r"|\bas\s+(a\s+)?(python\s+)?script\b",
    re.IGNORECASE,
)
_CODE_BLOCK_RE = re.compile(r"```(?:python)?\n?(.*?)```", re.DOTALL)


def _looks_like_code_request(prompt: str) -> bool:
    return bool(_CODE_REQUEST_RE.search(prompt or ""))


# A deterministic nudge (not a hard override - the SYSTEM_PROMPT rule above
# is the actual instruction) for the specific failure mode reported live: a
# request that explicitly asks to generate/create/build a TABLE was instead
# answered as a chart, because on its own the request can read like a
# summarize/aggregate "analyze" ask to a free model. This only ever adds an
# explicit reminder into the prompt sent to the model for this one turn - it
# never bypasses the model or writes code itself - so a genuinely ambiguous
# "table" mention elsewhere in a longer sentence still gets the model
# judgement, not a forced classification.
_TABLE_REQUEST_RE = re.compile(
    r"\b(generate|create|build|make|produce|give me)\b[^.?!\n]{0,60}\btable\b",
    re.IGNORECASE,
)


def _looks_like_table_request(prompt: str) -> bool:
    return bool(_TABLE_REQUEST_RE.search(prompt or ""))


# Another deterministic safety net, for the exact opposite situation: the
# person is not asking a new question at all, they are waving off whatever
# is currently on the table (a stuck clarifying question, a failed attempt,
# an old thread they no longer care about). A small/free model, given a
# short reply like "no leave it" plus several turns of unrelated history,
# can easily latch onto some earlier topic still sitting in that history and
# keep asking about IT instead of just dropping the subject - which is
# exactly the loop this exists to short-circuit. Deliberately narrow (whole
# phrase match, or substring only inside an otherwise very short message) so
# it never swallows a real request that happens to contain one of these
# words as part of a longer sentence.
_RESET_PHRASES = (
    "no leave it", "leave it", "never mind", "nevermind", "forget it", "forget that",
    "cancel", "cancel that", "scrap that", "drop it", "nvm", "start fresh", "start over",
    "reset", "never mind that", "ignore that", "skip it", "skip that", "not now", "no thanks",
)


def _looks_like_reset_request(prompt: str) -> bool:
    normalized = re.sub(r"[^a-z0-9\s]", "", (prompt or "").lower()).strip()
    normalized = re.sub(r"\s+", " ", normalized)
    if not normalized:
        return False
    if normalized in _RESET_PHRASES:
        return True
    if len(normalized.split()) <= 5:
        return any(phrase in normalized for phrase in _RESET_PHRASES)
    return False


def _extract_last_code_from_history(history: list[dict] | None) -> str | None:
    """Looks back through recent conversation history (as built by
    chat._recent_history, which embeds a "(The exact python code used for
    this: ```python ... ```)" note on any assistant turn that had one) for
    the most recent snippet - so a follow-up like "give me the python code"
    can be answered with exactly what was actually run, instead of the
    model having nothing concrete to go on and inventing a brand-new,
    unrelated analysis (which is what it was doing before this existed)."""
    for turn in reversed(history or []):
        if turn.get("role") != "assistant":
            continue
        match = _CODE_BLOCK_RE.search(turn.get("content") or "")
        if match:
            code = match.group(1).strip()
            if code:
                return code
    return None


# Matches the action-tagged code marker chat._recent_history embeds on an
# assistant turn that ran real code, e.g.:
#   (The exact python code used for this - action=analyze chart_type=heatmap: ```python ... ```)
# The chart_type token is only present for an analyze turn (a transform has
# no chart type of its own). Only rows saved after these columns were added
# carry this tag at all; older rows still carry a plain code marker (for
# the "give me the code" shortcut above) but without action=..., and are
# deliberately not matched here - see _find_repeated_prompt_code.
_REPEAT_CODE_RE = re.compile(
    r"\(The exact python code used for this - action=(\w+)(?:\s+chart_type=([^\s:]+))?:\s*```(?:python)?\n?(.*?)```\)",
    re.DOTALL,
)


def _find_repeated_prompt_code(prompt: str, history: list[dict] | None) -> tuple[str, str, str, str | None] | None:
    """Looks back through recent conversation history for an earlier
    occurrence of this EXACT SAME question (normalized for whitespace and
    case) whose reply carries an action-tagged code marker - i.e. a genuine
    analyze/transform this exact question already answered. If found,
    returns (action, narrative, code, chart_type) from that earlier turn
    (chart_type is None for a transform, or for an older row saved before
    that tag existed), so this repeat can re-run the identical code -
    and, for an analyze, redraw it with the identical chart type - instead
    of asking the model to write new code from scratch. Because the code
    would then be the literal same code, and pandas is deterministic, this
    makes "the same question against unchanged data gives the same answer"
    a guarantee of how the code runs, not just a strong likelihood based on
    the model behaving consistently."""
    if not history:
        return None
    normalized_prompt = re.sub(r"\s+", " ", (prompt or "").strip().lower())
    if not normalized_prompt:
        return None
    for i, turn in enumerate(history):
        if turn.get("role") != "user":
            continue
        turn_text = re.sub(r"\s+", " ", (turn.get("content") or "").strip().lower())
        if turn_text != normalized_prompt:
            continue
        if i + 1 >= len(history):
            continue
        reply = history[i + 1]
        if reply.get("role") != "assistant":
            continue
        match = _REPEAT_CODE_RE.search(reply.get("content") or "")
        if not match:
            continue
        action = match.group(1).strip()
        chart_type = match.group(2).strip() if match.group(2) else None
        code = match.group(3).strip()
        if action not in ("analyze", "transform") or not code:
            continue
        narrative = reply.get("content", "")[: match.start()].strip()
        return action, narrative, code, chart_type
    return None


def _infer_chart_type(prompt: str, result: Any, chart_type: str | None) -> str:
    """A deterministic safety net on top of the model own chart_type choice.
    Smaller/free models sometimes write a narrative describing one chart
    (e.g. "visualizing it with a scatter plot") while leaving the actual
    chart_type field at the generic "bar" default. This only steps in for
    that ambiguous case - chart_type missing or still "bar" - and only when
    the prompt itself gives a clear, specific signal for a better fit; it
    never overrides an explicit, deliberate choice the model already made,
    and never overrides an explicit chart_override the person picked
    themselves (that is applied by the caller before this is ever reached)."""
    if chart_type not in (None, "", "bar"):
        return chart_type
    fallback = chart_type or "bar"
    p = (prompt or "").lower()

    is_matrix = (
        isinstance(result, pd.DataFrame)
        and result.shape[0] > 1
        and result.shape[0] == result.shape[1]
        and list(result.columns) == list(result.index)
        and all(pd.api.types.is_numeric_dtype(result[c]) for c in result.columns)
    )
    two_numeric_cols = (
        isinstance(result, pd.DataFrame)
        and result.shape[1] == 2
        and all(pd.api.types.is_numeric_dtype(result[c]) for c in result.columns)
    )
    relationship_language = any(k in p for k in ("correlation", "relationship between", " vs ", " versus "))

    if relationship_language and is_matrix:
        return "heatmap"
    if relationship_language and two_numeric_cols:
        return "scatter"
    if any(k in p for k in ("distribution", "spread of", "histogram")):
        return "histogram"
    if any(k in p for k in ("trend", "over time", "time series", "month by month", "monthly", "year over year")):
        return "line"
    if any(k in p for k in ("share of", "proportion", "percentage breakdown", "% breakdown")):
        return "pie"
    if any(k in p for k in ("funnel", "conversion stage", "conversion rate by stage")):
        return "funnel"
    if any(k in p for k in ("cumulative", "waterfall", "build-up", "build up", "contribution to total")):
        return "waterfall"
    return fallback


# The exact note appended to the user-facing prompt content when the caller
# says this table was already prepared for this exact question (the
# "Continue" step after a paused, step-by-step preparation) - must stay
# byte-for-byte identical to the note SYSTEM_PROMPT tells the model to look
# for, so the model reliably recognizes it and skips preparation instead of
# doing it a second time.
_SKIP_PREP_NOTE = "(This table has already been prepared specifically for this analysis - skip preparation and analyze it directly.)"


# ---------------------------------------------------------------------------
# Deterministic "cross-tab" fast path - no AI, no sandbox, just pandas.
#
# "<metric> by <category> in each/for every/split by <second category>" is
# one of the single most common requests a data analyst tool gets (e.g.
# "profit by sub-category in each market") and, being a plain groupby +
# pivot, has exactly one correct answer - there is nothing for a model to
# creatively get right, only column names to get wrong. Asking a free-tier
# LLM to write fresh pandas code for this shape every single time is slow
# (a network round trip, sometimes two if the first attempt mis-names a
# dotted/spaced column or picks the wrong chart shape) and occasionally
# fails outright even after a retry - which is exactly the failure this
# section exists to eliminate. When the prompt confidently matches this
# shape and every column resolves unambiguously, this computes and renders
# the answer directly against the real dataframe - guaranteed correct
# (it's arithmetic, not generated code) and near-instant even at 100k+ rows,
# with a rich, analyst-style narrative instead of a bare chart. The moment
# any part of this is not confident - an unmatched phrasing, an ambiguous
# column, too many distinct values to read as a grid - it returns None and
# the request falls straight through to the normal AI-planned flow below,
# exactly as if this section did not exist.
# ---------------------------------------------------------------------------

_METRIC_PREFIX_RE = re.compile(r"^(total|average|avg|mean|sum(?:\s+of)?)\s+", re.IGNORECASE)
_CROSSTAB_CONNECTORS = (
    r"(?:in\s+each|for\s+each|for\s+every|per\s+each|split\s+by|broken\s+out\s+by|faceted\s+by|grouped\s+by)"
)
_CROSSTAB_RE = re.compile(
    rf"^(?P<metric>.+?)\s+by\s+(?P<cat1>.+?)\s+{_CROSSTAB_CONNECTORS}\s+(?P<cat2>.+)$",
    re.IGNORECASE,
)
_YEAR_RE = re.compile(r"\b((?:19|20)\d{2})\b")


def _normalize_phrase(s: str) -> str:
    """Loose-matches a phrase against a real column name regardless of how
    that column is punctuated in the actual file ("Sub.Category",
    "sub_category", "Sub Category" all normalize the same way) or whether
    the person used the singular/plural ("markets" -> "market") - this is
    what lets the cross-tab matcher below work against ANY dataset's real
    column names, not just one specific file's."""
    s = (s or "").lower().strip()
    s = re.sub(r"[.\-_/]+", " ", s)
    s = re.sub(r"[^a-z0-9\s]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    if s.endswith("ies") and len(s) > 4:
        s = s[:-3] + "y"
    elif s.endswith("ses") and len(s) > 4:
        s = s[:-2]
    elif s.endswith("s") and not s.endswith("ss") and len(s) > 3:
        s = s[:-1]
    return s


def _display_name(col: str) -> str:
    """Turns a real column name into something readable in generated prose
    and chart captions ("Sub.Category" -> "Sub Category", "order_date" ->
    "order date") without ever touching the actual column name used to
    index the dataframe - purely cosmetic, for narrative/insight text and
    chart title/axis captions."""
    return re.sub(r"[._]+", " ", str(col)).strip()


def _resolve_column(phrase: str, columns: list) -> Any | None:
    target = _normalize_phrase(phrase)
    if not target:
        return None
    for c in columns:
        if _normalize_phrase(str(c)) == target:
            return c
    target_tokens = set(target.split())
    best = None
    for c in columns:
        col_tokens = set(_normalize_phrase(str(c)).split())
        if not (target_tokens and col_tokens):
            continue
        # Allow the phrase to be a subset/superset of the column's own
        # words ("sub category" <-> "sub.category"), but only up to a
        # couple of stray extra words either side - past that it is too
        # loose a match to trust (e.g. "market as a bar chart" should not
        # silently resolve to "Market").
        if col_tokens <= target_tokens and len(target_tokens - col_tokens) <= 2:
            best = best or c
        elif target_tokens <= col_tokens and len(col_tokens - target_tokens) <= 2:
            best = best or c
    return best


def _crosstab_narrative(pivot: pd.DataFrame, metric_col: str, cat1_col: str, cat2_col: str, date_note: str) -> tuple[str, str]:
    """Builds the plain-English reply + insight straight from the pivoted
    numbers - every figure quoted here is read directly off `pivot` with
    plain pandas/Python arithmetic, never phrased by a model, so it is
    guaranteed to match the chart exactly."""
    totals_by_cat2 = pivot.sum(axis=0).sort_values(ascending=False)
    stacked = pivot.stack()
    best_row, best_col = stacked.idxmax()
    best_val = float(stacked.loc[(best_row, best_col)])
    losses = stacked[stacked < 0].sort_values()
    n_losses = int(len(losses))

    def fmt(v: float) -> str:
        return f"{v:,.1f}"

    metric_col, cat1_col, cat2_col = _display_name(metric_col), _display_name(cat1_col), _display_name(cat2_col)

    ranked_cat2 = list(totals_by_cat2.items())
    grand_total = float(pivot.to_numpy().sum())

    lines = [
        f"**Overall results{date_note}**",
        f"Total {metric_col.lower()}: {fmt(grand_total)}, across {pivot.shape[0]} {cat1_col.lower()} values "
        f"and {pivot.shape[1]} {cat2_col.lower()} values.",
        f"Top {cat2_col.lower()}: {ranked_cat2[0][0]} at {fmt(ranked_cat2[0][1])}"
        + (
            f", followed by {ranked_cat2[1][0]} ({fmt(ranked_cat2[1][1])}) and "
            f"{ranked_cat2[2][0]} ({fmt(ranked_cat2[2][1])})."
            if len(ranked_cat2) >= 3
            else (f", followed by {ranked_cat2[1][0]} ({fmt(ranked_cat2[1][1])})." if len(ranked_cat2) == 2 else ".")
        ),
        f"Highest single combination: {best_row} in {best_col}, at {fmt(best_val)}.",
    ]
    if n_losses:
        worst_row, worst_col = losses.index[0]
        lines.append(
            f"There are {n_losses} loss-making {cat1_col.lower()}/{cat2_col.lower()} combinations - the "
            f"biggest is {worst_row} in {worst_col} at {fmt(losses.iloc[0])}."
        )
    leader_lines = []
    for cat2_name in totals_by_cat2.index[:5]:
        col = pivot[cat2_name]
        leader = col.idxmax()
        leader_lines.append(f"{leader} leads {cat2_name} at {fmt(col.loc[leader])}.")
    if leader_lines:
        lines.append("**Key patterns**")
        lines.extend(leader_lines)
    narrative = "\n\n".join(lines)

    worst_focus = f"{losses.index[0][1]}" if n_losses else ranked_cat2[-1][0]
    insight = (
        f"**Key insight:** {ranked_cat2[0][0]} is the strongest {cat2_col.lower()} at {fmt(ranked_cat2[0][1])} "
        f"total {metric_col.lower()}, led within it by {best_row} at {fmt(best_val)}.\n"
        f"**Implication:** "
        + (
            f"{n_losses} combination(s) are actually losing {metric_col.lower()}, worth reviewing before "
            f"investing further there."
            if n_losses
            else f"Every {cat1_col.lower()}/{cat2_col.lower()} combination here is net-positive on {metric_col.lower()}."
        )
        + "\n"
        f"**Next step:** Drill into {worst_focus} to see what is driving its "
        f"{'losses' if n_losses else 'weaker numbers'}."
    )
    return narrative, insight


_EXPLICIT_FORMAT_RE = re.compile(r"\b(chart|graph|plot|panel|visuali[sz]e|diagram|table)\b", re.IGNORECASE)


def _try_deterministic_crosstab(prompt: str, df: pd.DataFrame, profile: dict) -> dict | None:
    m = _CROSSTAB_RE.match((prompt or "").strip())
    if not m:
        return None
    # A person who names a specific presentation ("...as a bar chart", "as
    # panels", "visualize...") cares about the format, not just the
    # numbers - that choice is always handed to the AI-planned flow (which
    # can honor grouped_bar/faceted_bar/etc. explicitly) rather than
    # silently defaulting to this fast path's own heatmap.
    if _EXPLICIT_FORMAT_RE.search(prompt or ""):
        return None

    metric_phrase = _METRIC_PREFIX_RE.sub("", m.group("metric")).strip()
    cat1_phrase = m.group("cat1").strip()
    cat2_raw = m.group("cat2").strip()
    cat2_phrase = _YEAR_RE.sub("", cat2_raw).strip(" ,.-")

    columns = list(df.columns)
    metric_col = _resolve_column(metric_phrase, columns)
    cat1_col = _resolve_column(cat1_phrase, columns)
    cat2_col = _resolve_column(cat2_phrase, columns)
    if not (metric_col and cat1_col and cat2_col) or len({metric_col, cat1_col, cat2_col}) < 3:
        return None
    if not pd.api.types.is_numeric_dtype(df[metric_col]):
        return None
    if pd.api.types.is_numeric_dtype(df[cat1_col]) or pd.api.types.is_numeric_dtype(df[cat2_col]):
        return None

    # A competitor-grade answer to this kind of request is never just the
    # single requested metric plotted on its own - it is a full breakdown
    # TABLE (e.g. Profit AND Sales AND an order count AND a profit margin,
    # not just Profit alone) saved as a real, keepable table alongside the
    # chart - see the final_table block below, right after the chart is
    # built. Pull in a couple of other genuinely metric-like numeric
    # columns for that table now (never an id/code/zip-style column, which
    # is never something to sum) - generic, so this works for any dataset,
    # not just one with columns named like Superstore's.
    id_like_re = re.compile(r"\b(id|code|zip|postal|number|no|lat|lon|latitude|longitude)\b", re.IGNORECASE)
    extra_numeric = [
        c for c in columns
        if c not in (cat1_col, cat2_col, metric_col)
        and pd.api.types.is_numeric_dtype(df[c])
        and not id_like_re.search(_normalize_phrase(str(c)))
    ][:2]
    # A distinct order/transaction count reads far more like a real
    # analyst's "Orders" column than a plain row count does, whenever the
    # data actually has an order/transaction identifier to count distinct
    # values of - fall back to a plain row count only when it does not.
    order_id_col = next(
        (
            c for c in columns
            if _normalize_phrase(str(c)) in ("order id", "order number", "order no", "orderid", "transaction id")
        ),
        None,
    )

    work_cols = list(dict.fromkeys(
        [cat1_col, cat2_col, metric_col] + extra_numeric + ([order_id_col] if order_id_col else [])
    ))
    work = df[work_cols].copy()

    years_in_prompt = [int(y) for y in _YEAR_RE.findall(prompt or "")]
    year_col = None
    date_note = ""
    lo = hi = None
    if years_in_prompt:
        lo, hi = min(years_in_prompt), max(years_in_prompt)
        year_col = _resolve_column("year", columns)
        if year_col and pd.api.types.is_numeric_dtype(df[year_col]):
            years_series = pd.to_numeric(df[year_col], errors="coerce")
            work = work[(years_series >= lo) & (years_series <= hi)]
            date_note = f" for {lo}-{hi}" if lo != hi else f" for {lo}"
        else:
            year_col = None
            date_col = next((c for c in columns if pd.api.types.is_datetime64_any_dtype(df[c])), None)
            if date_col is None:
                date_col = next((c for c in columns if "date" in _normalize_phrase(str(c))), None)
            if date_col is not None:
                try:
                    parsed = pd.to_datetime(df[date_col], errors="coerce")
                    mask = (parsed.dt.year >= lo) & (parsed.dt.year <= hi)
                    work = work[mask.fillna(False)]
                    date_note = f" for {lo}-{hi}" if lo != hi else f" for {lo}"
                except Exception:
                    pass

    work[metric_col] = pd.to_numeric(work[metric_col], errors="coerce")
    for extra_col in extra_numeric:
        work[extra_col] = pd.to_numeric(work[extra_col], errors="coerce")
    work = work.dropna(subset=[metric_col])
    if work.empty:
        return None

    n_cat1 = work[cat1_col].nunique()
    n_cat2 = work[cat2_col].nunique()
    # A heatmap reads cleanly up to a few dozen rows/columns; past that it
    # is an unreadable wall of tiny cells - fall through to the normal
    # AI-planned flow (which can choose a more suitable chart, or ask a
    # clarifying question) rather than force a bad one.
    if n_cat1 < 2 or n_cat2 < 2 or n_cat1 > 60 or n_cat2 > 60:
        return None

    pivot = work.pivot_table(index=cat1_col, columns=cat2_col, values=metric_col, aggfunc="sum", fill_value=0)
    pivot = pivot.loc[pivot.sum(axis=1).sort_values(ascending=False).index]
    pivot = pivot[pivot.sum(axis=0).sort_values(ascending=False).index]

    title = f"{_display_name(metric_col)} by {_display_name(cat1_col)} and {_display_name(cat2_col)}{date_note}"

    # Pick whichever chart actually reads best for this result, not one
    # fixed default - a small number of panels ("in each market", 7 of
    # them) reads exactly like the reference RStudio facet_wrap chart this
    # was built to match: one clean bar panel per value, easy to scan
    # side by side. Past a handful of panels that same layout turns into a
    # wall of tiny, hard-to-compare charts, so a single heatmap grid (every
    # combination in one glance) takes over instead - the same threshold
    # the SYSTEM_PROMPT heatmap rule uses for the AI-planned fallback path,
    # so both paths agree on when to switch.
    use_facets = n_cat2 <= 8
    # Built once, regardless of which chart shape gets drawn below, so the
    # Explore panel always has a genuinely tidy (one row per cat1/cat2/metric
    # combination) frame to remap - the heatmap branch's own `pivot` is a
    # wide matrix, not tidy, so it isn't usable for that directly.
    melted = pivot.reset_index().melt(id_vars=cat1_col, var_name=cat2_col, value_name=metric_col)
    facet_frame = melted[[cat2_col, cat1_col, metric_col]]
    try:
        if use_facets:
            chart_spec = build_figure(
                facet_frame, "faceted_bar", title,
                x_label=_display_name(metric_col), y_label=_display_name(cat1_col),
            )
            chosen_chart_type = "faceted_bar"
        else:
            chart_spec = build_figure(
                pivot, "heatmap", title,
                x_label=_display_name(cat2_col), y_label=_display_name(cat1_col),
            )
            chosen_chart_type = "heatmap"
    except Exception as e:
        print(f"[ai_engine] deterministic crosstab chart build failed for prompt={prompt!r}, falling back to AI: {e}")
        return None

    tidy = result_to_tidy(facet_frame)

    narrative, insight = _crosstab_narrative(pivot, metric_col, cat1_col, cat2_col, date_note)

    # The final, keepable breakdown TABLE - same shape and clarity as a
    # competitor's exported pivot (the requested metric plus related
    # metrics plus a count plus a computed margin, one row per cat1/cat2
    # combination), not just implied by the chart. This is what makes a
    # single click deliver a complete result the way an analyst would:
    # a real table to review/sort/download in the Data tab, AND the
    # right-fit chart, AND the written analysis - all at once, every time
    # this pattern is recognized, with zero AI/network round trip.
    agg_spec = {metric_col: "sum", **{c: "sum" for c in extra_numeric}}
    final_table = work.groupby([cat1_col, cat2_col], as_index=False).agg(agg_spec)
    if order_id_col:
        count_series = work.groupby([cat1_col, cat2_col])[order_id_col].nunique().reset_index(name="_count")
        count_label = f"{_display_name(order_id_col)} Count"
    else:
        count_series = work.groupby([cat1_col, cat2_col]).size().reset_index(name="_count")
        count_label = "Row Count"
    final_table = final_table.merge(count_series, on=[cat1_col, cat2_col], how="left")
    final_table = final_table.rename(columns={"_count": count_label})
    # A "margin" percentage is only meaningful for one specific, well-
    # understood shape: a profit-like metric divided by a sales/revenue-
    # like column, both denominated in the same currency (exactly the
    # "Profit Margin" a competitor tool computes). Dividing an arbitrary
    # metric by an arbitrary other numeric column (e.g. Sales by Quantity)
    # produces a number that LOOKS like a percentage but means nothing -
    # worse than not showing one at all - so this only ever fires for that
    # one specific, genuinely sensible case.
    # Plain lowercase + punctuation-to-space only - deliberately NOT
    # _normalize_phrase, whose plural-stripping would turn "Sales" into
    # "sale" and silently break a whole-word match against "sales".
    def _loose_lower(s: str) -> str:
        return re.sub(r"[._\-/]+", " ", str(s)).lower()

    _PROFIT_LIKE_RE = re.compile(r"\b(profit|margin|income|earnings)\b", re.IGNORECASE)
    _SALES_LIKE_RE = re.compile(r"\b(sales?|revenue|amount)\b", re.IGNORECASE)
    if _PROFIT_LIKE_RE.search(_loose_lower(metric_col)):
        sales_candidate = next(
            (c for c in extra_numeric if _SALES_LIKE_RE.search(_loose_lower(c))), None
        )
        if sales_candidate:
            margin_label = f"{_display_name(metric_col)} Margin (%)"
            final_table[margin_label] = (
                final_table[metric_col] / final_table[sales_candidate].replace(0, float("nan")) * 100
            ).round(1)
    # Order the table the same way the chart itself is ordered - biggest
    # cat1 totals first, then biggest metric value within each - so the
    # table and the chart tell the identical story, top to bottom.
    cat1_order = {name: i for i, name in enumerate(pivot.index)}
    final_table["_sort"] = final_table[cat1_col].map(cat1_order)
    final_table = final_table.sort_values(["_sort", metric_col], ascending=[True, False]).drop(columns="_sort")
    final_table = final_table.reset_index(drop=True)
    # Cosmetic column renaming happens only on this saved copy - the
    # dataframe used for the pivot/chart above still uses the real,
    # original column names throughout, so nothing about the actual
    # computation changes.
    final_table = final_table.rename(columns={c: _display_name(c) for c in final_table.columns})

    relevant_source_cols = list(dict.fromkeys([cat1_col, cat2_col, metric_col] + extra_numeric))
    nulls_before = int(df[relevant_source_cols].isna().sum().sum())
    nulls_after = int(final_table.isna().sum().sum())
    saved_cols_desc = ", ".join(c for c in final_table.columns if c not in (_display_name(cat1_col), _display_name(cat2_col)))
    narrative += (
        f"\n\nI also saved the complete {_display_name(cat1_col).lower()}-by-{_display_name(cat2_col).lower()} "
        f"breakdown as a new table ({saved_cols_desc}) - you can find it in the Data tab."
    )

    code_lines = ["result = df.copy()"]
    if year_col and lo is not None:
        code_lines.append(
            f"_years = pd.to_numeric(result[{year_col!r}], errors='coerce')\n"
            f"result = result[(_years >= {lo}) & (_years <= {hi})]"
        )
    code_lines.append(f"result[{metric_col!r}] = pd.to_numeric(result[{metric_col!r}], errors='coerce')")
    code_lines.append(
        f"result = result.pivot_table(index={cat1_col!r}, columns={cat2_col!r}, values={metric_col!r}, "
        f"aggfunc='sum', fill_value=0)"
    )
    if use_facets:
        code_lines.append(
            f"result = result.reset_index().melt(id_vars={cat1_col!r}, var_name={cat2_col!r}, "
            f"value_name={metric_col!r})[[{cat2_col!r}, {cat1_col!r}, {metric_col!r}]]"
        )
    code = "\n".join(code_lines) + "\n"

    if use_facets:
        alt_follow_up = {
            "label": "Show this as one combined heatmap instead",
            "prompt": f"Show {metric_col} by {cat1_col} and {cat2_col} as a heatmap.",
        }
    else:
        alt_follow_up = {
            "label": "Show this as small-multiple bar panels instead",
            "prompt": f"Show {metric_col} by {cat1_col} in each {cat2_col} as separate bar chart panels.",
        }

    return {
        "needs_clarification": False,
        "clarifying_question": None,
        "action": "analyze",
        "narrative": narrative,
        "chart_spec": chart_spec,
        "chart_type": chosen_chart_type,
        "insight": insight,
        "result_columns": tidy["columns"] if tidy else None,
        "result_rows": tidy["rows"] if tidy else None,
        "result_row_count": tidy["row_count"] if tidy else None,
        "result_truncated": tidy["truncated"] if tidy else False,
        # cleaned_df being set is what tells routers/chat.py a real,
        # executed table exists to persist as a new saved version (see
        # _save_cleaning_result) - the exact same contract an ordinary
        # transform uses, so this final breakdown table shows up in the
        # Data tab right alongside the chart, from this one click, with no
        # separate "now build me a table" follow-up question needed.
        "cleaned_df": final_table,
        "rows_before": int(len(df)),
        "rows_after": int(len(final_table)),
        "nulls_before": nulls_before,
        "nulls_after": nulls_after,
        "suggested_charts": suggest_charts(profile),
        "suggested_stats": suggest_stats(profile),
        "follow_up_suggestions": [
            alt_follow_up,
            {
                "label": "Explain the biggest loss-making combination",
                "prompt": f"Which {cat1_col} and {cat2_col} combination lost the most {metric_col}, and why might that be?",
            },
            {
                "label": "Visualize the saved breakdown table",
                "prompt": f"Visualize the {_display_name(metric_col)} by {_display_name(cat1_col)} and {_display_name(cat2_col)} table you just saved.",
            },
        ],
        "code": code,
    }


def analyze(
    prompt: str,
    tables: dict[str, pd.DataFrame],
    history: list[dict] | None = None,
    chart_override: dict | None = None,
    intent: str | None = None,
    guided: bool = False,
    skip_prep: bool = False,
    original_df: pd.DataFrame | None = None,
) -> dict:
    """
    Main entrypoint. `tables` maps display name -> DataFrame for every table
    the person selected (almost always just one; more than one when they
    picked several to compare/combine in a single prompt). Returns a dict
    with: needs_clarification, clarifying_question, action, narrative,
    chart_spec, insight, cleaned_df (set for a transform, or for an analyze
    that had to prepare its own table first), rows_before/after,
    nulls_before/after, suggested_charts, suggested_stats.

    `guided` controls what happens when an analyze question needs its own
    preparation step first (see the SYSTEM_PROMPT rule on prep_code): False
    (the default, "one-click explain" mode) runs preparation and the actual
    analysis together in one response, explained in one smooth narrative.
    True ("step-by-step" mode) stops right after preparation and returns a
    paused result (paused_for_continue=True) so the caller can show the
    prepared table and let the person confirm before the analysis runs.

    `skip_prep` is for the follow-up call that continues a paused
    step-by-step turn: it tells the model this table was already prepared
    for this exact question, so it should go straight to the analysis
    instead of preparing again.

    `original_df` is the original, untouched data, passed in whenever the
    person is working on a DERIVED table instead of the original (None when
    they already selected the original, or when it could not be loaded).
    When present, it is quietly made available to the model as a reference
    table a prep step can merge a missing column in from - see
    _schema_with_fallback - so a request like "switch back to the original
    dataset and calculate X" against a derived table that lacks a needed
    column succeeds in one pass instead of the AI just repeating a
    clarifying question the person already answered by naming the data
    they wanted used.

    If the first attempt fails (sandbox error, wrong result shape, or an
    unrenderable chart), the model is given one retry with the exact error
    attached before any of that reaches the caller - see module docstring.
    """
    df = next(iter(tables.values()))  # the primary table - profiling/suggestions are based on this one
    profile = profile_dataframe(df)
    explicit_table_names = list(tables.keys())
    tables, explicit_schema_text, fallback_note = _schema_with_fallback(tables, original_df)

    # A deterministic shortcut for when the person is simply waving off
    # whatever is currently pending (a stuck clarifying question, a failed
    # attempt, an old thread) - "no leave it", "start fresh", "never mind",
    # and the like. Answered with a plain, on-topic acknowledgment and
    # nothing else, without ever calling the model - so it can never drift
    # into re-asking about some unrelated leftover topic still sitting in
    # the conversation history, which is what a smaller/free model would
    # otherwise sometimes do with a short, low-content reply like this.
    if _looks_like_reset_request(prompt):
        return {
            "needs_clarification": False,
            "clarifying_question": None,
            "action": "explain",
            "narrative": "No problem, that is dropped. Let me know what you would like to look at next.",
            "chart_spec": None,
            "insight": None,
            "rows_before": None,
            "rows_after": None,
            "nulls_before": None,
            "nulls_after": None,
            "suggested_charts": suggest_charts(profile),
            "suggested_stats": suggest_stats(profile),
            "follow_up_suggestions": [],
            "code": None,
        }

    # A deterministic shortcut for the clearest, most common case this
    # covers: the person just got a result and is now asking to see the
    # code behind it (e.g. "can you give python code", "show me the
    # code"). Answered directly from what was actually run last time,
    # without even calling the model - both faster, and immune to a
    # smaller/free model misreading the question as a request for a new,
    # unrelated analysis. If there is nothing to hand back (e.g. this is
    # the very first message in the conversation), this falls through to
    # the normal model-driven flow below, which still has an
    # action="explain" rule to fall back on.
    if _looks_like_code_request(prompt):
        prior_code = _extract_last_code_from_history(history)
        if prior_code:
            narrative = (
                "Here is the exact Python code used for that result:\n\n"
                f"```python\n{prior_code}\n```"
            )
            return {
                "needs_clarification": False,
                "clarifying_question": None,
                "action": "explain",
                "narrative": narrative,
                "chart_spec": None,
                "insight": None,
                "rows_before": None,
                "rows_after": None,
                "nulls_before": None,
                "nulls_after": None,
                "suggested_charts": suggest_charts(profile),
                "suggested_stats": suggest_stats(profile),
                "follow_up_suggestions": [
                    {"label": "Explain this code", "prompt": "Explain what this code does, step by step, in plain English."},
                    {"label": "Show that result again", "prompt": "Show me that last result again."},
                ],
                "code": None,
            }

    # A deterministic shortcut for the extremely common "<metric> by
    # <category> in each/for every/split by <second category>" cross-tab
    # request (e.g. "profit by sub-category in each market") - see the
    # _try_deterministic_crosstab block above for why this exists and
    # exactly what it guarantees. Only engaged for the plain one-click flow
    # against a single selected table with no explicit chart override -
    # step-by-step mode, a multi-table selection, or an explicit chart
    # choice all fall straight through to the normal AI-planned flow below,
    # unaffected.
    if len(explicit_table_names) == 1 and not chart_override and not guided and not skip_prep:
        deterministic = _try_deterministic_crosstab(prompt, df, profile)
        if deterministic:
            return deterministic

    # A deterministic shortcut for the exact same question being asked
    # again: rather than asking the model to write pandas code for it a
    # second time (which, even at low randomness, is still an AI decision
    # and not a hard guarantee of picking the identical approach), just
    # re-run the identical code that answered it last time. Pandas is
    # deterministic, so replaying the same code against the same data is
    # guaranteed to give the same number, not just very likely to. If the
    # data has changed since (a column renamed, a row count different), the
    # replay naturally reflects that - it is the code that is fixed, not a
    # cached answer. If replaying old code no longer works at all (e.g. a
    # column it used no longer exists), this quietly falls through to the
    # normal AI-planned flow below instead of surfacing an error for what
    # looks, to the person, like an entirely reasonable repeat question.
    repeat = _find_repeated_prompt_code(prompt, history)
    if repeat:
        repeat_action, repeat_narrative, repeat_code, repeat_chart_type = repeat
        replay_plan = {
            "action": repeat_action,
            "narrative": repeat_narrative or "Re-running the same analysis as before, since this is the same question against the same data.",
            # Reusing the exact chart_type from last time (when known) keeps
            # the chart visually consistent too, not just the number behind
            # it - without this, re-deriving a chart type fresh could
            # independently land on a different, still-valid choice (e.g.
            # a correlation matrix could be redrawn as a heatmap instead of
            # the scatter it was shown as before) and look like a changed
            # answer even though the math is identical.
            "chart_type": repeat_chart_type,
            "title": None,
            "x_label": None,
            "y_label": None,
            "code": repeat_code,
            "follow_up_suggestions": [],
        }
        # A replayed turn re-runs an exact, already-known-good script and
        # must never pause - even in step-by-step mode - since there is
        # nothing new to confirm about a question already answered
        # identically before.
        replay_result = _execute_plan(prompt, tables, profile, replay_plan, chart_override, guided=False)
        if not replay_result.get("_retry_needed"):
            return replay_result

    schema_text = explicit_schema_text

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for turn in (history or [])[-6:]:
        messages.append({"role": turn["role"], "content": turn["content"]})

    user_content = f"Dataset schema:\n{schema_text}\n\nUser request: {prompt}"
    if len(explicit_table_names) > 1:
        names = explicit_table_names
        all_names = ", ".join(repr(n) for n in names)
        other_names = ", ".join(repr(n) for n in names[1:])
        user_content += (
            f"\n\nMore than one table was selected for this request: {all_names}. "
            f"They are all available in the `tables` dict by exact name (e.g. tables[{names[1]!r}]); "
            f"\"{names[0]}\" is also available as `df`. If the request implies comparing, combining, merging, "
            f"or reconciling tables, actually use {other_names} together with `df`, not just `df` alone."
        )
    if fallback_note:
        user_content += fallback_note
    hint = INTENT_HINTS.get(intent or "")
    if hint:
        user_content += f"\n\n(Context: {hint})"
    if _looks_like_table_request(prompt):
        user_content += (
            "\n\n(Context: this request explicitly asks to generate/create/build a table - use "
            "action=\"transform\" and assign the full resulting table to `result`, even though it involves "
            "aggregating or summarizing per group. See the system instructions rule on explicit table "
            "requests.)"
        )
    if chart_override:
        user_content += f"\n\nThe user also explicitly wants these chart customizations applied: {json.dumps(chart_override)}"
    if skip_prep:
        user_content += f"\n\n{_SKIP_PREP_NOTE}"
    messages.append({"role": "user", "content": user_content})

    plan = _plan_with_retry(messages)
    result = _execute_plan(prompt, tables, profile, plan, chart_override, guided)

    if result.pop("_retry_needed", False):
        # Give the model one chance to see exactly what went wrong with its
        # own plan/code and either fix it or recognize it genuinely needs
        # more information from the person - so a shaky first attempt (a
        # coding slip, or a request that turns out to be ambiguous once it
        # is actually run) quietly recovers instead of surfacing a
        # technical failure right away.
        retry_detail = result.pop("_retry_detail", "unknown error")
        print(f"[ai_engine] first attempt failed for prompt={prompt!r}: {retry_detail}")
        retry_messages = messages + [
            {"role": "assistant", "content": json.dumps(plan)},
            {
                "role": "user",
                "content": (
                    "Running that did not work. The error was:\n"
                    f"{retry_detail}\n\n"
                    "Please reconsider the request. If your approach had a mistake, fix it and respond "
                    "with corrected JSON (same schema as before). If you genuinely cannot tell what the "
                    "person wants without more information, respond with action=\"clarify\" and ask ONE "
                    "short, specific question instead."
                ),
            },
        ]
        try:
            fixed_plan = _plan_with_retry(retry_messages)
            result = _execute_plan(prompt, tables, profile, fixed_plan, chart_override, guided)
        except Exception as e:
            print(f"[ai_engine] retry call itself raised for prompt={prompt!r}: {e}")
            pass  # keep the first attempt friendly failure message already in `result`
        if result.get("_retry_needed"):
            print(f"[ai_engine] retry ALSO failed for prompt={prompt!r}: {result.get('_retry_detail')}")
        result.pop("_retry_needed", None)
        result.pop("_retry_detail", None)

    return result


def _execute_plan(
    prompt: str, tables: dict[str, pd.DataFrame], profile: dict, plan: dict, chart_override: dict | None, guided: bool = False,
) -> dict:
    action = plan.get("action") or "analyze"

    if action == "clarify":
        return _no_result(
            profile,
            "",
            needs_clarification=True,
            clarifying_question=plan.get("clarifying_question") or "Could you clarify what you would like to do?",
        )

    if action == "explain":
        return _run_explain(profile, plan)

    code = plan.get("code") or ""

    if action == "transform":
        return _run_transform(prompt, tables, profile, plan, code)

    if (plan.get("prep_code") or "").strip():
        return _run_analyze_with_prep(prompt, tables, profile, plan, chart_override, guided)

    return _run_analyze(prompt, tables, profile, plan, code, chart_override)


def _run_explain(profile: dict, plan: dict) -> dict:
    """Handles action="explain": a question ABOUT the data/a prior
    result/a method/code, not a new thing to compute. No sandbox, no
    chart - its narrative IS the complete answer, exactly the way a
    knowledgeable analyst would just answer a question in words instead
    of running a fresh, unrelated analysis for it."""
    narrative = (plan.get("narrative") or "").strip()
    if not narrative:
        narrative = "I do not have anything specific to reference for that yet - could you tell me a bit more about what you would like to know?"
    return {
        "needs_clarification": False,
        "clarifying_question": None,
        "action": "explain",
        "narrative": narrative,
        "chart_spec": None,
        "insight": None,
        "rows_before": None,
        "rows_after": None,
        "nulls_before": None,
        "nulls_after": None,
        "suggested_charts": suggest_charts(profile),
        "suggested_stats": suggest_stats(profile),
        "follow_up_suggestions": _sanitize_follow_ups(plan.get("follow_up_suggestions")),
        "code": None,
    }


def _run_transform(prompt: str, tables: dict[str, pd.DataFrame], profile: dict, plan: dict, code: str) -> dict:
    cleaned, error = run_sandboxed(code, tables, timeout=settings.SANDBOX_TIMEOUT_SECONDS)

    if error:
        result = _no_result(profile, _TRANSFORM_FAILURE_NARRATIVE)
        result["action"] = "transform"
        result["_retry_needed"] = True
        result["_retry_detail"] = error.splitlines()[-1] if error else "unknown error"
        return result

    if not isinstance(cleaned, pd.DataFrame):
        result = _no_result(profile, _TRANSFORM_FAILURE_NARRATIVE)
        result["action"] = "transform"
        result["_retry_needed"] = True
        result["_retry_detail"] = "The code ran but did not assign a full table to `result`."
        return result

    # With a single table selected this is exactly the old before/after
    # comparison; with several selected, "before" reflects everything that
    # went in, since e.g. a merge or a comparison legitimately starts from
    # the combined rows across every selected table. These numbers still
    # feed the plain-English "N rows -> M rows, X -> Y missing values"
    # summary text - only the auto-generated bar chart is gone (see below).
    rows_before = sum(len(t) for t in tables.values())
    rows_after = int(len(cleaned))
    nulls_before = sum(int(t.isna().sum().sum()) for t in tables.values())
    nulls_after = int(cleaned.isna().sum().sum())

    # A transform means "give me a table" - never attach a chart here, even
    # a small before/after one. Auto-generating a chart nobody asked for
    # (and that has nothing to do with the table's actual content, e.g. a
    # groupby that deliberately collapses 100 rows into 2) confused people
    # into thinking an irrelevant chart was the answer to their question.
    chart_spec = None

    new_profile = profile_dataframe(cleaned)
    summary = result_to_summary(cleaned)
    # The real row count behind this result, so the insight can cite an
    # actual sample size (n) instead of leaving it unstated.
    summary["source_row_count"] = rows_after
    insight = _generate_insight(prompt, summary)

    return {
        "needs_clarification": False,
        "clarifying_question": None,
        "action": "transform",
        "narrative": plan.get("narrative") or "Data prepared.",
        "chart_spec": chart_spec,
        "insight": insight,
        "cleaned_df": cleaned,
        "rows_before": rows_before,
        "rows_after": rows_after,
        "nulls_before": nulls_before,
        "nulls_after": nulls_after,
        "suggested_charts": suggest_charts(new_profile),
        "suggested_stats": suggest_stats(new_profile),
        "follow_up_suggestions": _sanitize_follow_ups(plan.get("follow_up_suggestions")),
        "code": code,
    }


def _run_analyze_with_prep(
    prompt: str, tables: dict[str, pd.DataFrame], profile: dict, plan: dict, chart_override: dict | None, guided: bool,
) -> dict:
    """Handles action="analyze" whenever the model produced a prep_code step
    (see the "Preparing the data before every analyze answer" rule in
    SYSTEM_PROMPT): runs the preparation step for real first, against the
    original table(s) - genuinely building the exact, minimal, clean table
    this specific question needs, not just claiming to - then persists it
    as a new saved version (via cleaned_df below, same as a transform) so
    the person can see and trust it in the Data tab.

    When `guided` is False ("one-click explain" mode), the chart-producing
    step then runs immediately after, in this SAME response, and the whole
    thing - prep and analysis - is explained in one smooth narrative.

    When `guided` is True ("step-by-step" mode), this stops right after the
    preparation step and hands back a paused result (paused_for_continue) so
    the caller can show the prepared table and let the person confirm
    before the actual analysis runs - see continue_action in routers/chat.py."""
    prep_code = (plan.get("prep_code") or "").strip()
    prep_narrative = (plan.get("prep_narrative") or "").strip() or "Preparing the data needed for this analysis."

    prepped, prep_error = run_sandboxed(prep_code, tables, timeout=settings.SANDBOX_TIMEOUT_SECONDS)

    if prep_error or not isinstance(prepped, pd.DataFrame):
        out = _no_result(profile, _ANALYZE_FAILURE_NARRATIVE)
        out["action"] = "analyze"
        out["_retry_needed"] = True
        out["_retry_detail"] = (
            prep_error.splitlines()[-1] if prep_error
            else "The preparation step ran but did not assign a full table to `result`."
        )
        return out

    rows_before = sum(len(t) for t in tables.values())
    rows_after = int(len(prepped))
    nulls_before = sum(int(t.isna().sum().sum()) for t in tables.values())
    nulls_after = int(prepped.isna().sum().sum())
    prepped_profile = profile_dataframe(prepped)

    if guided:
        # This is the paused "here is the prepared table, confirm to
        # continue" step, not the final analysis - it is still just a
        # table at this point, so (same as a plain transform, above) no
        # chart gets attached here either. The real chart is built once the
        # person continues past this pause, further down in this function.
        prep_chart_spec = None
        prep_summary = result_to_summary(prepped)
        prep_summary["source_row_count"] = rows_after
        prep_insight = _generate_insight(prompt, prep_summary)
        return {
            "needs_clarification": False,
            "clarifying_question": None,
            "action": "analyze",
            "narrative": prep_narrative,
            "chart_spec": prep_chart_spec,
            "insight": prep_insight,
            "cleaned_df": prepped,
            "rows_before": rows_before,
            "rows_after": rows_after,
            "nulls_before": nulls_before,
            "nulls_after": nulls_after,
            "suggested_charts": suggest_charts(prepped_profile),
            "suggested_stats": suggest_stats(prepped_profile),
            "follow_up_suggestions": [],
            "code": prep_code,
            # Tells routers/chat.py this turn is paused right after
            # preparation, waiting on the person to continue into the
            # actual analysis - never set outside step-by-step mode.
            "paused_for_continue": True,
        }

    primary_name = next(iter(tables.keys()))
    chart_code = plan.get("code") or ""
    result, error = run_sandboxed(chart_code, {primary_name: prepped}, timeout=settings.SANDBOX_TIMEOUT_SECONDS)

    if error:
        out = _no_result(profile, _ANALYZE_FAILURE_NARRATIVE)
        out["action"] = "analyze"
        out["_retry_needed"] = True
        out["_retry_detail"] = error.splitlines()[-1] if error else "unknown error"
        return out

    chart_type = (chart_override or {}).get("chart_type") or plan.get("chart_type") or "bar"
    if not (chart_override or {}).get("chart_type"):
        chart_type = _infer_chart_type(prompt, result, chart_type)
    title = (chart_override or {}).get("title") or plan.get("title") or prompt[:80]
    try:
        chart_spec = build_figure(result, chart_type, title, plan.get("x_label"), plan.get("y_label"))
    except Exception as e:
        out = _no_result(profile, _ANALYZE_FAILURE_NARRATIVE)
        out["action"] = "analyze"
        out["_retry_needed"] = True
        out["_retry_detail"] = f"Could not render the result as a {chart_type} chart: {e}"
        return out

    # The same underlying rows this chart was built from, serialized tidy -
    # lets the frontend's Explore panel remap axes/chart type/filters
    # client-side against the real numbers, instead of only ever having the
    # one fixed Plotly figure above. See result_to_tidy's own docstring.
    tidy = result_to_tidy(result)

    summary = result_to_summary(result)
    summary["source_row_count"] = rows_after
    insight = _generate_insight(prompt, summary)

    chart_narrative = plan.get("narrative") or "Here is your analysis."
    combined_narrative = f"**Data prep:** {prep_narrative}\n\n**Analysis:** {chart_narrative}"
    # One combined script - preparation, then the chart code against the
    # prepared table - stored as the single `code` this turn ran, so "give
    # me the code" hands back the real, complete pipeline, and a later
    # exact repeat of this same question (see _find_repeated_prompt_code)
    # can replay it deterministically in one pass without needing a second
    # preparation step or creating a second saved version.
    combined_code = (
        f"{prep_code}\n\n"
        "# --- preparation complete; the analysis below runs against the prepared table ---\n"
        "df = result\n\n"
        f"{chart_code}"
    )

    return {
        "needs_clarification": False,
        "clarifying_question": None,
        "action": "analyze",
        "narrative": combined_narrative,
        "chart_spec": chart_spec,
        "chart_type": chart_type,
        "insight": insight,
        "cleaned_df": prepped,
        "rows_before": rows_before,
        "rows_after": rows_after,
        "nulls_before": nulls_before,
        "nulls_after": nulls_after,
        "suggested_charts": suggest_charts(prepped_profile),
        "suggested_stats": suggest_stats(prepped_profile),
        "follow_up_suggestions": _sanitize_follow_ups(plan.get("follow_up_suggestions")),
        "code": combined_code,
        "result_columns": tidy["columns"] if tidy else None,
        "result_rows": tidy["rows"] if tidy else None,
        "result_row_count": tidy["row_count"] if tidy else None,
        "result_truncated": tidy["truncated"] if tidy else False,
    }


def _run_analyze(prompt: str, tables: dict[str, pd.DataFrame], profile: dict, plan: dict, code: str, chart_override: dict | None) -> dict:
    result, error = run_sandboxed(code, tables, timeout=settings.SANDBOX_TIMEOUT_SECONDS)

    if error:
        out = _no_result(profile, _ANALYZE_FAILURE_NARRATIVE)
        out["action"] = "analyze"
        out["_retry_needed"] = True
        out["_retry_detail"] = error.splitlines()[-1] if error else "unknown error"
        return out

    chart_type = (chart_override or {}).get("chart_type") or plan.get("chart_type") or "bar"
    if not (chart_override or {}).get("chart_type"):
        # Only ever corrects the model own ambiguous "bar" default toward a
        # better fit for this specific request - never overrides a chart
        # type the person explicitly picked, and never fights a deliberate,
        # specific choice the model already made.
        chart_type = _infer_chart_type(prompt, result, chart_type)
    title = (chart_override or {}).get("title") or plan.get("title") or prompt[:80]
    try:
        chart_spec = build_figure(result, chart_type, title, plan.get("x_label"), plan.get("y_label"))
    except Exception as e:
        out = _no_result(profile, _ANALYZE_FAILURE_NARRATIVE)
        out["action"] = "analyze"
        out["_retry_needed"] = True
        out["_retry_detail"] = f"Could not render the result as a {chart_type} chart: {e}"
        return out

    # See the identical call in _run_analyze_with_prep above.
    tidy = result_to_tidy(result)

    summary = result_to_summary(result)
    # The real row count of the table this was computed from, so the
    # insight can cite an actual sample size (n) instead of leaving it
    # unstated or, worse, the model guessing one.
    summary["source_row_count"] = int(len(next(iter(tables.values()))))
    insight = _generate_insight(prompt, summary)

    return {
        "needs_clarification": False,
        "clarifying_question": None,
        "action": "analyze",
        "narrative": plan.get("narrative") or "Here is your analysis.",
        "chart_spec": chart_spec,
        # The chart_type actually used, after any override/inference - kept
        # so an exact repeat of this same question later can reuse it and
        # stay visually consistent, not just numerically consistent.
        "chart_type": chart_type,
        "insight": insight,
        "rows_before": None,
        "rows_after": None,
        "nulls_before": None,
        "nulls_after": None,
        "suggested_charts": suggest_charts(profile),
        "suggested_stats": suggest_stats(profile),
        "follow_up_suggestions": _sanitize_follow_ups(plan.get("follow_up_suggestions")),
        "code": code,
        "result_columns": tidy["columns"] if tidy else None,
        "result_rows": tidy["rows"] if tidy else None,
        "result_row_count": tidy["row_count"] if tidy else None,
        "result_truncated": tidy["truncated"] if tidy else False,
    }


def _augment_summary_with_computed_stats(summary: dict) -> dict:
    """Pre-computes a small set of comparison statistics in Python - the
    gap between the top and bottom category, that gap expressed as
    percentage points (when the values are ratios/proportions between 0
    and 1) and as a relative percent change, plus the full ranking - and
    attaches them under summary["computed"]. This exists specifically so
    the insight-writing model is never the one doing the subtraction: a
    model composing a sentence and doing arithmetic in the same breath is
    exactly where a wrong number (e.g. writing "6.4 percentage points" for
    a gap that is actually 3.4) can slip in even when every input number it
    was given was correct. Every figure here is computed with plain Python
    arithmetic on numbers already present in the summary, so it is
    guaranteed correct; the model is only ever asked to narrate it."""
    preview = summary.get("preview") or []
    if not isinstance(preview, list) or len(preview) < 2 or len(preview) > 12:
        return summary
    first = preview[0]
    if not isinstance(first, dict):
        return summary

    numeric_col = None
    label_col = None
    for key, val in first.items():
        if numeric_col is None and isinstance(val, (int, float)) and not isinstance(val, bool):
            numeric_col = key
        elif label_col is None:
            label_col = key
    if numeric_col is None:
        return summary

    rows = []
    for r in preview:
        if not isinstance(r, dict) or numeric_col not in r:
            continue
        val = r.get(numeric_col)
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            continue
        rows.append((str(r.get(label_col, "item")), float(val)))
    if len(rows) < 2:
        return summary

    ranked = sorted(rows, key=lambda x: x[1], reverse=True)
    top_label, top_val = ranked[0]
    bottom_label, bottom_val = ranked[-1]
    gap = top_val - bottom_val

    computed = {
        "ranked": [{"label": lbl, "value": round(v, 4)} for lbl, v in ranked],
        "top": {"label": top_label, "value": round(top_val, 4)},
        "bottom": {"label": bottom_label, "value": round(bottom_val, 4)},
        "gap_absolute": round(gap, 4),
    }
    if bottom_val:
        computed["gap_relative_percent"] = round(gap / bottom_val * 100, 2)
    if all(0 <= v <= 1 for _, v in rows):
        computed["gap_percentage_points"] = round(gap * 100, 2)

    summary = dict(summary)
    summary["computed"] = computed
    return summary


def _fallback_insight(summary: dict) -> str:
    """Used only if the model genuinely could not write an insight after
    every retry below (e.g. a transient provider error) - builds a plain,
    still-structured insight straight from the computed summary instead of
    a message with no real content in it. Every number here is read
    directly out of the summary (including the Python-computed "computed"
    section, when present), never invented, so it stays accurate even
    though it is simpler than what the model would normally write."""
    scalar = summary.get("scalar_result")
    if isinstance(scalar, (int, float)):
        value = round(scalar, 3)
        n = summary.get("source_row_count")
        n_text = f" (n = {n})" if isinstance(n, int) else ""
        return (
            f"**Key insight:** The computed result for this request is {value}{n_text}.\n"
            f"**Implication:** Compare this figure against what you would expect for these columns to judge "
            f"whether it is strong, weak, or typical.\n"
            f"**Next step:** Break this down further - for example by a category or over time - to see what is "
            f"driving this number."
        )
    computed = summary.get("computed") or {}
    top = computed.get("top")
    bottom = computed.get("bottom")
    if top and bottom:
        top_label = top.get("label")
        top_value = top.get("value")
        bottom_label = bottom.get("label")
        bottom_value = bottom.get("value")
        gap_points = computed.get("gap_percentage_points")
        gap_abs = computed.get("gap_absolute")
        gap_rel = computed.get("gap_relative_percent")
        gap_desc = f"{gap_points} percentage points" if gap_points is not None else f"{gap_abs}"
        relative = f" ({gap_rel}% relative)" if gap_rel is not None else ""
        n = summary.get("source_row_count")
        n_text = f" (n = {n})" if isinstance(n, int) else ""
        return (
            f"**Key insight:** {top_label} leads at {top_value}, versus {bottom_label} at "
            f"{bottom_value} - a gap of {gap_desc}{relative}{n_text}.\n"
            f"**Implication:** {top_label} is meaningfully ahead of {bottom_label} on this measure.\n"
            f"**Next step:** Look into what is different about {top_label} versus {bottom_label} to "
            f"understand what is driving this gap."
        )
    preview = summary.get("preview") or []
    if preview:
        first = preview[0]
        pairs = ", ".join(f"{k}: {v}" for k, v in list(first.items())[:4])
        return (
            f"**Key insight:** The leading result shown above is {pairs}.\n"
            f"**Implication:** This is the top figure in the breakdown you asked for.\n"
            f"**Next step:** Compare it against the rest of the results in the chart above to see how much it "
            f"stands out."
        )
    return "Insight generation is temporarily unavailable, but the result above reflects the requested analysis."


def _generate_insight(prompt: str, summary: dict) -> str:
    summary = _augment_summary_with_computed_stats(summary)
    messages = [
        {"role": "system", "content": INSIGHT_SYSTEM_PROMPT},
        {"role": "user", "content": f"The user asked: {prompt}\n\nResult data summary (JSON): {json.dumps(summary)[:4000]}"},
    ]
    # A real, model-written insight is noticeably richer than the plain
    # template _fallback_insight below falls back to (it cites the sample
    # size, phrases the gap in natural language, and reads like an analyst
    # wrote it), so it is worth one retry before giving up on it. The
    # first attempt already has a generous token budget, so a failure here
    # is usually either a transient provider hiccup or an empty response
    # from a reasoning model that used its whole budget thinking rather
    # than answering - both recover fine on a second try. The one case
    # where retrying is pure waste is a real "tokens per day" rate limit,
    # since a second call in the same second will hit the exact same wall -
    # that case is detected and skipped so this never doubles the cost of
    # an insight during an actual rate-limit stretch. Every failure is
    # logged so a genuine, repeated provider problem is visible in the
    # service logs.
    last_error_text = ""
    for attempt in (1, 2):
        try:
            text = _call_llm(messages, max_tokens=1400).strip()
            if text:
                return text
            last_error_text = "empty response"
        except Exception as e:
            last_error_text = str(e)
            print(f"[ai_engine] insight generation attempt {attempt} failed: {e}")
        if "429" in last_error_text or "rate_limit" in last_error_text.lower() or "tokens per day" in last_error_text.lower():
            break
    return _fallback_insight(summary)


def _reverify_via_replan(
    prompt: str, tables: dict[str, pd.DataFrame], history: list[dict] | None, action: str, issue_detail: str,
    original_df: pd.DataFrame | None = None,
) -> dict:
    """Used by verify_answer below when a previously-shown answer needs to
    be redone from scratch - either its code no longer runs against the
    current data, or a fresh review pass found a genuine logic problem with
    it. Re-plans the request with the model from a clean slate, explicitly
    telling it what was wrong with the first attempt so it does not simply
    repeat the same mistake. This intentionally calls the model/execute
    steps directly rather than going through analyze() above, so it never
    hits the exact-repeat replay shortcut in analyze() - replaying would
    just find and reuse that very same flawed code again. `original_df`
    is the same merge-fallback reference table analyze() offers - see
    _schema_with_fallback - so a redo can also pull in a column missing
    from the currently selected table(s) instead of just failing again."""
    profile = profile_dataframe(next(iter(tables.values())))
    tables, schema_text, fallback_note = _schema_with_fallback(tables, original_df)
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    for turn in (history or [])[-6:]:
        messages.append({"role": turn["role"], "content": turn["content"]})
    messages.append({
        "role": "user",
        "content": (
            f"Dataset schema:\n{schema_text}\n\nUser request: {prompt}\n\n"
            f"(A review of a previous answer to this exact request found a problem: {issue_detail} "
            "Please solve this correctly from scratch - do not repeat that mistake.)"
        ) + fallback_note,
    })
    plan = _plan_with_retry(messages)
    result = _execute_plan(prompt, tables, profile, plan, None)
    result.pop("_retry_needed", None)
    result.pop("_retry_detail", None)

    if result.get("action") != action:
        # The corrected plan disagrees about what KIND of request this even
        # is (e.g. now thinks it should be a transform, not an analyze) -
        # too big a change to silently swap into the existing message in
        # place, so this surfaces as guidance instead of an auto-fix.
        return {
            "status": "unavailable",
            "message": (
                f"The review found that this needs a different kind of approach than before ({issue_detail}). "
                "Rather than silently swap this in place, please ask the question again as a new message so "
                "you can see the corrected approach clearly."
            ),
            "result": None,
        }

    return {
        "status": "corrected",
        "message": f"Found and corrected an issue: {issue_detail}",
        "result": result,
    }


def verify_answer(
    prompt: str,
    tables: dict[str, pd.DataFrame],
    code: str,
    action: str,
    chart_type: str | None,
    insight: str | None,
    history: list[dict] | None = None,
    original_df: pd.DataFrame | None = None,
) -> dict:
    """Re-checks a previously computed, already-shown answer for
    correctness, on demand (the "Double-check this" action) - rather than
    the person having to trust a first pass indefinitely. Two things are
    checked: that the exact code still runs and gives the same computed
    numbers against the current data, and that a fresh, independent AI
    audit pass - given the REAL freshly-recomputed numbers, not the old
    ones - agrees the code and the insight genuinely are correct for the
    question. `original_df`, when given, is threaded into any redo (see
    _reverify_via_replan) as the same merge-fallback reference table
    analyze() offers. Returns {"status": "confirmed"|"corrected"|
    "unavailable", "message": str, "result": dict|None} - "result" (in the
    same shape _execute_plan returns) is only present for "corrected",
    ready for the caller to persist in place of the original message
    fields."""
    df = next(iter(tables.values()))

    result, error = run_sandboxed(code, tables, timeout=settings.SANDBOX_TIMEOUT_SECONDS)
    if error:
        detail = error.splitlines()[-1] if error else "unknown error"
        return _reverify_via_replan(
            prompt, tables, history, action,
            f"the original code no longer runs against the current data ({detail}).",
            original_df=original_df,
        )
    if action == "transform" and not isinstance(result, pd.DataFrame):
        return _reverify_via_replan(
            prompt, tables, history, action,
            "the code ran but did not produce a full table as a transform should.",
            original_df=original_df,
        )

    summary = result_to_summary(result)
    summary["source_row_count"] = int(len(result)) if action == "transform" else int(len(df))
    summary = _augment_summary_with_computed_stats(summary)

    not_applicable = "n/a"
    none_shown = "(none)"
    audit_user_content = (
        f"The user originally asked: {prompt}\n\n"
        f"The python code that was run to answer it:\n```python\n{code}\n```\n\n"
        f"The chart type used to display this (only meaningful for an analyze request): {chart_type or not_applicable}\n\n"
        f"The computed result, freshly re-run just now against the current data (JSON): "
        f"{json.dumps(summary)[:4000]}\n\n"
        f"The plain-English insight text that was shown to the user based on this result: {insight or none_shown}"
    )
    audit_messages = [
        {"role": "system", "content": VERIFY_SYSTEM_PROMPT},
        {"role": "user", "content": audit_user_content},
    ]

    # A second attempt is worth it here for the same reason it is in
    # _generate_insight above: an empty/malformed first response is usually
    # a transient hiccup, and this is an explicit, on-demand "Double-check
    # this" click - the person is actively waiting on it, so it is worth
    # recovering from a shaky first attempt rather than immediately
    # reporting "could not verify". Skipped on a real rate-limit error,
    # since a second call right away would just hit the same wall. Every
    # failure is logged.
    verdict = None
    last_error_text = ""
    for attempt in (1, 2):
        try:
            raw = _call_llm(audit_messages, max_tokens=700)
            verdict = _extract_json(raw)
            break
        except Exception as e:
            last_error_text = str(e)
            print(f"[ai_engine] verify audit attempt {attempt} failed: {e}")
        if "429" in last_error_text or "rate_limit" in last_error_text.lower() or "tokens per day" in last_error_text.lower():
            break

    if verdict is None:
        return {
            "status": "unavailable",
            "message": (
                "Automatic verification could not be completed right now (the AI service did not respond). "
                "The original answer is unchanged - please try again in a moment."
            ),
            "result": None,
        }

    if bool(verdict.get("verified")):
        return {
            "status": "confirmed",
            "message": (
                "Verified: the code correctly computes what was asked, and every number in the insight "
                "matches the freshly recomputed result. No changes were needed."
            ),
            "result": None,
        }

    issue = (verdict.get("issue") or "").strip() or "the original approach did not correctly answer the question."
    return _reverify_via_replan(prompt, tables, history, action, issue, original_df=original_df)


def _goku_profile_text(tables: dict[str, pd.DataFrame], max_cols: int = 40) -> str:
    """Builds the real, concrete facts Goku reasons from - unlike
    _dataset_schema_text above (used by the main analysis chat, which just
    needs column names/types), this includes how much of each column is
    missing and a few real example values, so Goku can actually judge what
    a column IS (an id, an email, a price, free text) and whether the data
    looks ready to analyze - the whole point of a beginner-guidance
    assistant is grounded, specific advice, never a generic checklist.
    Capped at max_cols per table (same cap chart_suggester.profile_dataframe
    already uses elsewhere) so a very wide dataset cannot blow up the token
    cost of every single Goku message - Goku still gets the real column
    count and can ask the person to point out which specific columns
    matter, rather than silently reasoning over dozens of unshown ones."""
    blocks = []
    for name, table_df in tables.items():
        total = len(table_df)
        all_cols = list(table_df.columns)
        shown_cols = all_cols[:max_cols]
        lines = [f"Table \"{name}\": {total} rows, {len(all_cols)} columns."]
        for col in shown_cols:
            series = table_df[col]
            nulls = int(series.isna().sum())
            null_pct = round(nulls / total * 100, 1) if total else 0.0
            sample_values = series.dropna().astype(str).unique()[:3].tolist()
            sample_text = ", ".join(sample_values) if sample_values else "(no non-empty values)"
            lines.append(
                f"  - {col} ({series.dtype}): {nulls} missing ({null_pct}%). Example values: {sample_text}"
            )
        if len(all_cols) > max_cols:
            lines.append(
                f"  (...and {len(all_cols) - max_cols} more columns not shown here - ask the person which "
                "ones matter most if you need to reason about them.)"
            )
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def _goku_model_override() -> str | None:
    """Which model override, if any, Goku should use instead of the current
    provider default model (see GEMINI_GOKU_MODEL / GOKU_MODEL in config.py
    for why: Goku only ever writes plain guidance chat, never pandas code,
    so it can run on a lighter, cheaper model of its own). Returns None for
    a provider with no separate Goku model configured, in which case Goku
    simply uses that provider default model like every other caller does."""
    if settings.AI_PROVIDER == "gemini":
        return settings.GEMINI_GOKU_MODEL
    if settings.AI_PROVIDER == "groq":
        return settings.GOKU_MODEL
    return None


def _strip_self_echo_action_prompts(action_prompts: list[dict], user_message: str) -> list[dict]:
    """A deterministic safety net for a specific failure mode a free model
    occasionally falls into: proposing an action_prompt whose "prompt" text
    is essentially the exact same thing the person just said - which, if
    clicked, just resends that same message and can loop Goku back to the
    same clarifying question forever instead of moving the process forward.
    Mirrors the same "trust the model generally, guarantee the obvious case"
    layering already used elsewhere in this module (e.g.
    _looks_like_reset_request, _find_repeated_prompt_code)."""
    normalized_user = re.sub(r"\s+", " ", (user_message or "").strip().lower())
    if not normalized_user:
        return action_prompts
    out = []
    for item in action_prompts:
        normalized_prompt = re.sub(r"\s+", " ", (item.get("prompt") or "").strip().lower())
        if normalized_prompt == normalized_user:
            continue
        out.append(item)
    return out


def goku_chat(
    user_message: str,
    tables: dict[str, pd.DataFrame],
    goku_history: list[dict] | None,
    main_chat_history: list[dict] | None,
    main_chat_status: str | None = None,
) -> dict:
    """Goku: the guided, beginner-friendly helper that lives only in the
    Workspace page (see routers/goku.py). Unlike the main analysis chat,
    Goku never runs code or computes anything itself - it only reasons
    over a real profile of the currently selected data (columns, types,
    missing values, example values) plus its own recent conversation and -
    when available - what has already happened in the person main
    analysis chat, so it can give concrete, grounded, step-by-step
    guidance instead of generic advice. main_chat_status, when given, is a
    small deterministic fact (built in routers/goku.py from the real
    database row, not inferred from prose) saying whether the most recent
    main-chat step genuinely completed - this is what lets Goku open with a
    real "Done" confirmation and one clear "Next:" step instead of only
    guessing from the chat text. Returns {"reply": str, "action_prompts":
    [{"label": str, "prompt": str}, ...]}."""
    profile_text = _goku_profile_text(tables)

    messages = [{"role": "system", "content": GOKU_SYSTEM_PROMPT}]
    for turn in (goku_history or [])[-12:]:
        messages.append({"role": turn["role"], "content": turn["content"]})

    context_parts = [f"Current data profile:\n{profile_text}"]
    if main_chat_history:
        chat_lines = []
        for turn in main_chat_history[-10:]:
            speaker = "Person" if turn["role"] == "user" else "Main analysis chat"
            turn_content = turn["content"]
            chat_lines.append(f"{speaker}: {turn_content}")
        context_parts.append("Recent activity in the main analysis chat:\n" + "\n".join(chat_lines))
    else:
        context_parts.append("The person has not asked the main analysis chat anything yet.")
    if main_chat_status:
        context_parts.append(f"Status: {main_chat_status}")
    context_parts.append(f"The person just said to you, Goku: {user_message}")

    messages.append({"role": "user", "content": "\n\n".join(context_parts)})

    # Goku uses a lighter, cheaper model than the main analysis chat (see
    # _goku_model_override above). A second attempt is worth it here for
    # the same reason it is in _generate_insight below: an empty/malformed
    # first response is usually a transient hiccup, not evidence the
    # request itself is unanswerable, and Goku guidance quality matters
    # for building trust with someone new to data analysis. The one case
    # where retrying is pure waste is a real rate-limit error, since a
    # second call right away would just hit the same wall - that case is
    # detected and skipped. Every failure is logged.
    parsed = None
    last_error_text = ""
    for attempt in (1, 2):
        try:
            raw = _call_llm(messages, max_tokens=900, model_override=_goku_model_override())
            parsed = _extract_json(raw)
            break
        except Exception as e:
            last_error_text = str(e)
            print(f"[ai_engine] goku_chat attempt {attempt} failed: {e}")
        if "429" in last_error_text or "rate_limit" in last_error_text.lower() or "tokens per day" in last_error_text.lower():
            break

    if parsed is None:
        return {
            "reply": (
                "I am having trouble reaching the AI service right now - please try asking again in a moment."
            ),
            "action_prompts": [],
        }

    reply = (parsed.get("reply") or "").strip() or "Could you tell me a bit more about what you would like to do with this data?"
    action_prompts = _sanitize_follow_ups(parsed.get("action_prompts"))
    action_prompts = _strip_self_echo_action_prompts(action_prompts, user_message)
    return {"reply": reply, "action_prompts": action_prompts}


def parse_filter_prompt(prompt: str, columns: list[str], dtypes: dict[str, str]) -> dict:
    """Turns a plain-English filter request ("orders over $500 in
    California") into the same structured per-column filter shape the Data
    tab's manual Excel-style filter panel already builds
    (DataTable.tsx's ColumnFilterSpec) and routers/datasources.py's
    _apply_column_filter already knows how to apply - this is the whole
    trick that lets the natural-language filter bar reuse every bit of
    filtering machinery the Values/Condition panel already has, rather
    than needing its own separate execution path. Returns
    {"filters": {"<column>": {...spec...}, ...}, "note": "<...>"} - `note`
    is one short, plain-language sentence the filter bar shows back,
    confirming what got filtered (or explaining briefly why nothing did).

    Deliberately conservative: only ever proposes a filter on a column
    that both actually exists on this table AND that the model named
    itself (a hallucinated column name is silently dropped, never passed
    through to the query layer), so a misunderstood request narrows to
    nothing rather than filtering on the wrong thing."""
    columns_text = "\n".join(f"  - {c} ({dtypes.get(c, 'object')})" for c in columns)
    system = (
        "You turn a short, plain-English data-filtering request into structured JSON "
        "filters for a table with exactly these columns:\n" + columns_text + "\n\n"
        "Respond with ONLY a single JSON object of this exact shape, nothing else:\n"
        '{"filters": {"<column name, spelled exactly as listed above>": <spec>, ...}, "note": "<short sentence>"}\n\n'
        "Each <spec> must be one of:\n"
        '  {"type": "text", "op": "contains"|"not_contains"|"equals"|"not_equals"|"starts_with"|"ends_with"|"is_empty"|"is_not_empty", "value": "..."}\n'
        '  {"type": "number", "op": "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"between", "value": "123.45", "value2": "678.9"}  ("value2" only for "between")\n'
        '  {"type": "date", "from": "YYYY-MM-DD" or null, "to": "YYYY-MM-DD" or null}\n'
        '  {"type": "boolean", "value": "true" or "false"}\n'
        '  {"type": "values", "include": ["<exact value1>", "<exact value2>", ...]}  (for a short, specific list of category values, e.g. two or three named states or products)\n\n'
        "Rules:\n"
        "- Only ever use a column name from the list above, spelled exactly as given there. Never invent a column.\n"
        "- Only include a column in \"filters\" if the request clearly says something about it - never add a filter on a column the person did not mention.\n"
        "- Use the \"number\" type for a numeric column (money amounts, counts, quantities): strip currency symbols and thousands separators from the value (\"$500\" -> \"500\").\n"
        "- Use the \"date\" type for a date/time column, resolving any relative phrase (\"last month\", \"this year\", \"last 7 days\") into actual YYYY-MM-DD bounds using today's date, which is " + date.today().isoformat() + ".\n"
        "- \"note\" is exactly one short, friendly, non-technical sentence confirming what was filtered (e.g. \"Showing orders over $500 in California.\"). If no column in the request matches anything on this table, return {\"filters\": {}, \"note\": \"<a brief, friendly explanation of what could not be understood>\"}.\n"
    )
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": prompt},
    ]
    result = _plan_with_retry(messages)
    filters = result.get("filters") if isinstance(result, dict) else None
    if not isinstance(filters, dict):
        filters = {}
    # A hallucinated or misspelled column name should never silently reach
    # the filter layer - drop anything that isn't a real column on this
    # table, and anything that isn't itself a proper filter object.
    filters = {col: spec for col, spec in filters.items() if col in columns and isinstance(spec, dict)}
    note = result.get("note") if isinstance(result, dict) else None
    if not isinstance(note, str):
        note = ""
    return {"filters": filters, "note": note.strip()}
