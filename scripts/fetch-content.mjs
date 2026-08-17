#!/usr/bin/env node
/**
 * fetch-content.mjs — pulls Cardano news + governance proposals,
 * translates them to Swedish via Vercel AI Gateway, and writes
 * data/news.json + data/proposals.json for the swada.se site.
 *
 * Translation is cached: an item is only retranslated if its source text
 * changes. Existing translations carry over across runs.
 *
 * Environment:
 *   TRANSLATE_API_KEY   — Key for Pelles processor (OpenAI-compatible).
 *                         Absent key = items keep raw English text and are
 *                         retried on later runs.
 *   TRANSLATE_ENDPOINT  — Chat-completions URL.
 *   TRANSLATE_MODEL     — Model name.
 *
 * The lane may be slow (local model) or down (host asleep). Design: every
 * run finishes and commits regardless — a per-run translation budget stops
 * new attempts near the 7-minute mark, and untranslated items catch up on
 * subsequent hourly runs.
 *
 * Usage:
 *   node scripts/fetch-content.mjs
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const AI_KEY = process.env.TRANSLATE_API_KEY || "";
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || "local-llm";
const TRANSLATE_ENDPOINT = process.env.TRANSLATE_ENDPOINT
  || "https://api.pellesprocessor.se/v1/chat/completions";
// Local models are slow — allow up to 4 min per call, but cap the total time
// spent translating per run so the job always finishes and commits.
const TRANSLATE_CALL_TIMEOUT_MS = 240_000;
const TRANSLATE_RUN_BUDGET_MS = 7 * 60_000;
const runStart = Date.now();

const UA = "swada-bot/1.0 (+https://swada.se)";

// Every network call gets a deadline — the job runs under a 10-minute CI
// timeout, and one unresponsive host (e.g. a dead vote-anchor URL) must not
// hang the whole refresh.
const fetchT = (url, opts = {}, ms = 20_000) =>
  fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
const loadJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const saveJSON = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");

// --- translation via Pelles processor ---------------------------------------
// Circuit breaker: after 3 consecutive failed texts (timeouts when the host
// is asleep, connection errors, or hard rate limits) we stop calling the
// endpoint for the rest of the run; untranslated items retry next run.
let consecutiveFailures = 0;

// The workflow requests an alias (local-llm); log once per run which
// concrete model the gateway reports serving it.
let servedModelLogged = false;

// Reasoning models often prepend their chain-of-thought in <think> blocks —
// keep only the actual translation.
const stripThinking = (s) =>
  s.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^<think>[\s\S]*/i, "").trim();

// Long texts make the local model generate for minutes and blow the call
// timeout (a 1400-char proposal abstract repeatedly hit 240s). Translate in
// sentence-boundary chunks so each call's output stays bounded.
const CHUNK_LIMIT = 700;
function chunkText(text) {
  if (text.length <= CHUNK_LIMIT) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > CHUNK_LIMIT) {
    let cut = rest.lastIndexOf(". ", CHUNK_LIMIT);
    if (cut < CHUNK_LIMIT * 0.4) cut = rest.lastIndexOf(" ", CHUNK_LIMIT);
    if (cut < 1) cut = CHUNK_LIMIT;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

async function translateToSwedish(text, prevTranslation, prevHash) {
  if (!text || !text.trim()) return { sv: "", hash: "" };
  const inputHash = sha(text);
  if (prevTranslation && prevHash === inputHash) {
    return { sv: prevTranslation, hash: inputHash };
  }
  const blocked = () =>
    !AI_KEY || consecutiveFailures >= 3 || Date.now() - runStart > TRANSLATE_RUN_BUDGET_MS;
  if (blocked()) return { sv: "", hash: inputHash, untranslated: true };
  const out = [];
  for (const part of chunkText(text)) {
    if (blocked()) return { sv: "", hash: inputHash, untranslated: true };
    const sv = await translateChunk(part);
    if (!sv) return { sv: "", hash: inputHash, untranslated: true };
    out.push(sv);
  }
  return { sv: out.join(" "), hash: inputHash };
}

// One bounded call to the gateway; returns "" on any failure.
async function translateChunk(text) {
  const sys = "Du är en professionell översättare som översätter Cardano-blockchain-innehåll från engelska till svenska. Behåll tekniska termer (DRep, stake, pool, ADA, Cardano, smart contract, blockchain, treasury, governance action, m.fl.) på engelska där de är vedertagna. Översätt kortfattat, sakligt och korrekt. Returnera ENDAST den svenska översättningen, ingen kommentar, ingen formatering.";
  const user = `Översätt följande text till svenska:\n\n${text}`;
  try {
    const body = {
      model: TRANSLATE_MODEL,
      // Chunks are ≤700 chars, so ~1200 tokens is ample for the translation
      // while bounding runaway generations on the local model.
      max_tokens: 1200,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
    };
    // gpt-5 / o-series reasoning models burn tokens on chain-of-thought.
    // Reserve most of the budget for actual output, not thinking.
    if (TRANSLATE_MODEL.includes("gpt-5") || TRANSLATE_MODEL.startsWith("openai/o")) {
      body.reasoning_effort = "minimal";
    }
    // Retry with backoff on 429 (rate limit) and 5xx (transient)
    let resp;
    for (let attempt = 0; attempt < 4; attempt++) {
      resp = await fetchT(TRANSLATE_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${AI_KEY}`,
        },
        body: JSON.stringify(body),
      }, TRANSLATE_CALL_TIMEOUT_MS);
      if (resp.ok) break;
      if (resp.status !== 429 && resp.status < 500) break;
      const wait = 1500 * (2 ** attempt) + Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, wait));
    }
    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      console.error(`  translate failed (${resp.status}): ${err.slice(0,200)}`);
      consecutiveFailures++;
      if (consecutiveFailures === 3) {
        console.error("  endpoint failing repeatedly — skipping remaining translations this run");
      }
      return "";
    }
    consecutiveFailures = 0;
    // Small inter-call pacing to be a good citizen on shared free tier.
    await new Promise((r) => setTimeout(r, 300));
    const data = await resp.json();
    if (!servedModelLogged && data.model) {
      console.log(`  served by model: ${data.model}`);
      servedModelLogged = true;
    }
    const sv = stripThinking((data.choices?.[0]?.message?.content || "").trim());
    if (!sv) {
      const fr = data.choices?.[0]?.finish_reason || "?";
      const u = data.usage || {};
      console.error(`  translate empty: finish=${fr} prompt=${u.prompt_tokens} completion=${u.completion_tokens} reasoning=${u.completion_tokens_details?.reasoning_tokens}`);
    }
    return sv;
  } catch (e) {
    console.error(`  translate error: ${e.message}`);
    consecutiveFailures++;
    if (consecutiveFailures === 3) {
      console.error("  endpoint unreachable — skipping remaining translations this run");
    }
    return "";
  }
}

// --- news source 1: Cardano Forum (Discourse JSON API) ---------------------
async function fetchCardanoForum(limit = 8) {
  const url = "https://forum.cardano.org/latest.json?order=created";
  const resp = await fetchT(url, {
    headers: { "User-Agent": UA, "Accept": "application/json" },
  });
  if (!resp.ok) throw new Error(`forum.cardano.org: ${resp.status}`);
  const data = await resp.json();
  return (data.topic_list?.topics || []).slice(0, limit).map((t) => ({
    id: `forum:${t.id}`,
    source: "Cardano Forum",
    title_en: t.title,
    summary_en: (t.excerpt || "").replace(/\s+/g, " ").trim().slice(0, 400),
    url: `https://forum.cardano.org/t/${t.slug}/${t.id}`,
    date: t.created_at,
    score: t.like_count || 0,
    comments: Math.max(0, (t.posts_count || 1) - 1),
  }));
}

// --- news source 2: AdaPulse RSS ------------------------------------------
async function fetchAdaPulse(limit = 5) {
  const resp = await fetchT("https://adapulse.io/feed/", {
    headers: { "User-Agent": UA, "Accept": "application/rss+xml" },
  });
  if (!resp.ok) throw new Error(`adapulse: ${resp.status}`);
  const xml = await resp.text();
  const grab = (block, tag) => {
    const cdata = block.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`));
    if (cdata) return cdata[1];
    const plain = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return plain ? plain[1] : "";
  };
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && items.length < limit) {
    const block = m[1];
    const title = grab(block, "title").trim();
    const link = grab(block, "link").trim();
    const pubDate = grab(block, "pubDate").trim();
    const desc = grab(block, "description")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&[lr]squo;|&#82(16|17);/g, "'")
      .replace(/&[lr]dquo;|&#82(20|21);/g, '"')
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
    if (!title || !link) continue;
    items.push({
      id: `adapulse:${sha(link)}`,
      source: "AdaPulse",
      title_en: title,
      summary_en: desc,
      url: link,
      date: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
    });
  }
  return items;
}

// --- pool live stats (Koios pool_info + pool_history) ---------------------
const POOL_ID_BECH32 = "pool1t9ckjy949dk97prfs6any8xdjyq9du6prnplx06n4fcn5jgukhc";

async function fetchPoolStats() {
  const infoResp = await fetchT("https://api.koios.rest/api/v1/pool_info", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ _pool_bech32_ids: [POOL_ID_BECH32] }),
  });
  if (!infoResp.ok) throw new Error(`pool_info: ${infoResp.status}`);
  const infoList = await infoResp.json();
  const i = infoList[0] || {};
  const summary = {
    pool_id_bech32: i.pool_id_bech32 || POOL_ID_BECH32,
    active_stake: i.active_stake,
    live_stake: i.live_stake,
    live_pledge: i.live_pledge,
    live_delegators: i.live_delegators,
    live_saturation: i.live_saturation,
    block_count: i.block_count,
    op_cert_counter: i.op_cert_counter,
    sigma: i.sigma,
    pool_status: i.pool_status,
  };

  const histResp = await fetchT(
    `https://api.koios.rest/api/v1/pool_history?_pool_bech32=${POOL_ID_BECH32}&order=epoch_no.desc&limit=10`,
    { headers: { "User-Agent": UA } },
  );
  if (!histResp.ok) throw new Error(`pool_history: ${histResp.status}`);
  const epochs = await histResp.json();

  // Current epoch + the pool's most recent blocks. pool_history excludes the
  // in-progress epoch and rewards lag two epochs, so these let the site show
  // "block minted, rewards pending" instead of misleading zeros.
  let current_epoch = null;
  let recent_blocks = [];
  try {
    const tipResp = await fetchT("https://api.koios.rest/api/v1/tip", {
      headers: { "User-Agent": UA },
    });
    if (tipResp.ok) current_epoch = (await tipResp.json())[0]?.epoch_no ?? null;

    const blocksResp = await fetchT(
      `https://api.koios.rest/api/v1/blocks?pool=eq.${POOL_ID_BECH32}&order=block_height.desc&limit=5`,
      { headers: { "User-Agent": UA } },
    );
    if (blocksResp.ok) {
      recent_blocks = (await blocksResp.json()).map((b) => ({
        epoch_no: b.epoch_no,
        block_height: b.block_height,
        block_time: b.block_time,
        hash: b.hash,
      }));
    }
  } catch (e) {
    console.error(`  tip/blocks failed (non-fatal): ${e.message}`);
  }

  return { summary, current_epoch, recent_blocks, epochs };
}

// --- iFly DRep votes (Koios vote_list) --------------------------------------
// iFly has had two on-chain DRep registrations: the current one and the
// retired 2026 original. We query all IDs (in both bech32 formats, since
// Koios accepts one or the other depending on endpoint version) so the
// voting history keeps the old votes while new votes come from the new DRep.
const DREP_IDS = [
  "drep1yg228a8u4jc5qnqmerhs4e29jyyjac3g39z399kt8gr8vfc0ylw7s", // current, CIP-129
  "drep1zj3lfl9vk9qycx7gau9w23v3pyhwy2yfg5ffdje6qemzwkl36au",  // current, CIP-105
  "drep1yfk64j2zmjssfyucggmgjr56clagysx2ct5ucqlf4nq8hrqp23kfa", // retired, CIP-129
  "drep1dk4vjsku5yzf8xzzx6ysaxk8l2pypjkza8xq86dvcpaccdwje5r",  // retired, CIP-105
];

// Pull the Swedish part out of a bilingual vote rationale. Recognizes an
// explicit "SV:"/"Svenska:" marker; otherwise accepts the whole text only if
// it plainly reads as Swedish. Returns "" when nothing Swedish is found —
// the site then falls back to data/proposal-notes.json.
function extractSwedish(text) {
  if (!text || !text.trim()) return "";
  const marked = text.match(
    /(?:^|\n)\s*(?:SV|Svenska|På svenska)\s*[:\-–—]\s*([\s\S]*?)(?=(?:^|\n)\s*(?:EN|English|Engelska)\s*[:\-–—]|$)/i,
  );
  if (marked) return marked[1].trim();
  const hasSwedishChars = (text.match(/[åäöÅÄÖ]/g) || []).length >= 2;
  const hasSwedishWords = /(^|\s)(och|att|för|inte|som|därför|eftersom)(\s|[.,])/i.test(text);
  if (hasSwedishChars && hasSwedishWords) return text.trim();
  return "";
}

async function fetchDrepVotes() {
  // Aggregate votes from every registration; a bech32 variant that Koios
  // doesn't recognize just returns an empty list, and duplicates from
  // querying both formats of the same DRep collapse in the dedupe below.
  const all = [];
  for (const drepId of DREP_IDS) {
    try {
      const resp = await fetchT(
        `https://api.koios.rest/api/v1/vote_list?voter_role=eq.DRep&voter_id=eq.${drepId}&order=block_time.desc&limit=100`,
        { headers: { "User-Agent": UA } },
      );
      if (!resp.ok) {
        console.error(`  vote_list (${drepId.slice(0, 16)}…): ${resp.status}`);
        continue;
      }
      all.push(...await resp.json());
    } catch (e) {
      console.error(`  vote_list (${drepId.slice(0, 16)}…): ${e.message}`);
    }
  }
  all.sort((a, b) => (b.block_time || 0) - (a.block_time || 0));
  const byProposal = {};
  for (const v of all) {
    if (byProposal[v.proposal_id]) continue; // newest vote per proposal wins
    let rationaleRaw =
      v.meta_json?.body?.comment || v.meta_json?.body?.rationale || "";
    if (!rationaleRaw && /^https?:\/\//.test(v.meta_url || "")) {
      try {
        const metaResp = await fetchT(v.meta_url, { headers: { "User-Agent": UA } }, 10_000);
        if (metaResp.ok) {
          const meta = await metaResp.json();
          rationaleRaw = meta?.body?.comment || meta?.body?.rationale || "";
        }
      } catch { /* anchor unreachable — vote still shown without rationale */ }
    }
    byProposal[v.proposal_id] = {
      vote: v.vote, // Yes | No | Abstain
      block_time: v.block_time ? new Date(v.block_time * 1000).toISOString() : null,
      rationale_sv: extractSwedish(rationaleRaw),
    };
  }
  return byProposal;
}

// --- governance proposals from Koios ---------------------------------------
function shapeProposal(p) {
  const meta = p.meta_json?.body || {};
  return {
    id: `gov:${p.proposal_id}`,
    proposal_id: p.proposal_id,
    type: p.proposal_type,
    proposed_epoch: p.proposed_epoch,
    expiration_epoch: p.expiration,
    title_en: (meta.title || "").trim() || `${p.proposal_type} proposal`,
    // Long enough for the /forslag detail page; the index card trims further.
    summary_en: (meta.abstract || "").trim().slice(0, 1400),
    url: `https://gov.tools/governance_actions/${p.proposal_id}`,
    block_time: p.block_time ? new Date(p.block_time * 1000).toISOString() : null,
    deposit_ada: p.deposit ? Number(p.deposit) / 1_000_000 : null,
  };
}

async function fetchProposals(limit = 8) {
  const url = `https://api.koios.rest/api/v1/proposal_list?dropped_epoch=is.null&expired_epoch=is.null&enacted_epoch=is.null&order=expiration.desc&limit=${limit}`;
  const resp = await fetchT(url, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`Koios proposals: ${resp.status}`);
  const list = await resp.json();
  return list.map(shapeProposal);
}

// Every proposal iFly has voted on — regardless of whether it is still
// active — for the /rostningar voting-history page.
async function fetchVotedProposals(votesByProposal) {
  const ids = Object.keys(votesByProposal);
  if (!ids.length) return [];
  const url = `https://api.koios.rest/api/v1/proposal_list?proposal_id=in.(${ids.join(",")})&limit=${ids.length}`;
  const resp = await fetchT(url, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`Koios voted proposals: ${resp.status}`);
  const list = await resp.json();
  const statusOf = (p) =>
    p.enacted_epoch != null ? "enacted"
    : p.ratified_epoch != null ? "ratified"
    : p.expired_epoch != null ? "expired"
    : p.dropped_epoch != null ? "dropped"
    : "active";
  return list
    .map((p) => ({ ...shapeProposal(p), status: statusOf(p), ifly_vote: votesByProposal[p.proposal_id] }))
    .sort((a, b) => ((a.ifly_vote?.block_time || "") < (b.ifly_vote?.block_time || "") ? 1 : -1));
}

function mergeItems(existing, fresh, key = "id") {
  const oldMap = new Map((existing || []).map((it) => [it[key], it]));
  return fresh.map((it) => {
    const prev = oldMap.get(it[key]);
    return {
      ...it,
      title_sv: prev?.title_sv ?? "",
      summary_sv: prev?.summary_sv ?? "",
      _title_sha: prev?._title_sha ?? "",
      _summary_sha: prev?._summary_sha ?? "",
    };
  });
}

async function translateItems(items, label) {
  let translated = 0, cached = 0, skipped = 0;
  for (const it of items) {
    const wasTitleSv = it.title_sv;
    const wasSummarySv = it.summary_sv;
    const t1 = await translateToSwedish(it.title_en, it.title_sv, it._title_sha);
    if (t1.sv) it.title_sv = t1.sv;
    if (t1.hash) it._title_sha = t1.hash;

    const t2 = await translateToSwedish(it.summary_en, it.summary_sv, it._summary_sha);
    if (t2.sv) it.summary_sv = t2.sv;
    if (t2.hash) it._summary_sha = t2.hash;

    if (t1.untranslated || t2.untranslated) skipped++;
    else if (it.title_sv !== wasTitleSv || it.summary_sv !== wasSummarySv) translated++;
    else cached++;
  }
  console.log(`  ${label}: translated=${translated} cached=${cached} skipped=${skipped}`);
}

async function main() {
  console.log(`fetch-content @ ${new Date().toISOString()} model=${TRANSLATE_MODEL} endpoint=${new URL(TRANSLATE_ENDPOINT).host}`);
  console.log(`translate key: ${AI_KEY ? "present" : "ABSENT (English only)"}`);

  console.log("\n=== News ===");
  const newsFile = path.join(DATA_DIR, "news.json");
  const existingNews = loadJSON(newsFile)?.items || [];
  let news = [];
  for (const [name, fn] of [
    ["forum.cardano.org", () => fetchCardanoForum(8)],
    ["adapulse.io", () => fetchAdaPulse(5)],
  ]) {
    try {
      const items = await fn();
      console.log(`  ${name}: ${items.length} items`);
      news.push(...items);
    } catch (e) {
      console.error(`  ${name} failed: ${e.message}`);
    }
  }
  const seen = new Set();
  news = news
    .filter((n) => !seen.has(n.id) && (seen.add(n.id), true))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 10);
  news = mergeItems(existingNews, news);
  await translateItems(news, "news");
  saveJSON(newsFile, { fetched_at: new Date().toISOString(), items: news });

  console.log("\n=== Governance proposals ===");
  const propsFile = path.join(DATA_DIR, "proposals.json");
  const existingProps = loadJSON(propsFile)?.items || [];
  let props = [];
  try {
    props = await fetchProposals(8);
    console.log(`  fetched ${props.length} active proposals`);
  } catch (e) {
    console.error(`  Koios failed: ${e.message}`);
  }
  let votes = {};
  try {
    votes = await fetchDrepVotes();
    let matched = 0;
    for (const p of props) {
      if (votes[p.proposal_id]) {
        p.ifly_vote = votes[p.proposal_id];
        matched++;
      }
    }
    console.log(`  iFly votes: ${Object.keys(votes).length} on-chain, ${matched} on active proposals`);
  } catch (e) {
    console.error(`  drep votes failed (non-fatal): ${e.message}`);
  }
  props = mergeItems(existingProps, props);
  await translateItems(props, "proposals");
  saveJSON(propsFile, { fetched_at: new Date().toISOString(), items: props });

  console.log("\n=== Voting history ===");
  const votesFile = path.join(DATA_DIR, "votes.json");
  const existingVotes = loadJSON(votesFile)?.items || [];
  let votedItems = [];
  try {
    votedItems = await fetchVotedProposals(votes);
    console.log(`  fetched ${votedItems.length} voted proposals`);
  } catch (e) {
    console.error(`  Koios failed: ${e.message}`);
  }
  if (votedItems.length) {
    votedItems = mergeItems(existingVotes, votedItems);
    // The archive is a union: items that stop appearing in the fetch (e.g.
    // votes of a retired DRep no longer indexed) are kept from last time.
    const freshIds = new Set(votedItems.map((v) => v.proposal_id));
    const carried = existingVotes.filter((v) => !freshIds.has(v.proposal_id));
    if (carried.length) console.log(`  carrying ${carried.length} archived items no longer returned by Koios`);
    votedItems = votedItems.concat(carried).sort((a, b) =>
      ((a.ifly_vote?.block_time || "") < (b.ifly_vote?.block_time || "") ? 1 : -1));
    await translateItems(votedItems, "votes");
    saveJSON(votesFile, { fetched_at: new Date().toISOString(), items: votedItems });
  } else {
    // A failed fetch must not wipe the archive.
    console.log(`  keeping existing votes.json (${existingVotes.length} items)`);
  }

  console.log("\n=== Pool stats ===");
  const statsFile = path.join(DATA_DIR, "pool-stats.json");
  try {
    const stats = await fetchPoolStats();
    saveJSON(statsFile, { fetched_at: new Date().toISOString(), ...stats });
    console.log(`  saved pool stats: ${stats.epochs.length} epochs, lifetime blocks=${stats.summary.block_count}`);
  } catch (e) {
    console.error(`  pool stats failed: ${e.message}`);
  }

  console.log("\nDone.");
}

await main();
