#!/usr/bin/env node
/**
 * fetch-content.mjs — pulls Cardano news + governance proposals,
 * translates them to Swedish via Vercel AI Gateway (Anthropic Haiku),
 * and writes data/news.json + data/proposals.json for the swada.se site.
 *
 * Translation is cached: an item is only retranslated if its source text
 * changes. Existing translations carry over across runs.
 *
 * Environment:
 *   AI_GATEWAY_API_KEY  — Vercel AI Gateway key. Optional. If absent,
 *                         items are stored with raw English text only.
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

const AI_KEY = process.env.AI_GATEWAY_API_KEY || "";
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || "openai/gpt-5-nano";
const TRANSLATE_ENDPOINT = "https://ai-gateway.vercel.sh/v1/chat/completions";

const UA = "swada-bot/1.0 (+https://swada.se)";

// --- utility: hash a string -------------------------------------------------
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);

// --- utility: load + save JSON ---------------------------------------------
function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

// --- translation via AI Gateway --------------------------------------------
// Cached on-disk via the `sourceHash` field; only retranslates if input changed.
async function translateToSwedish(text, prevTranslation, prevHash) {
  if (!text || !text.trim()) return { sv: "", hash: "" };
  const inputHash = sha(text);
  if (prevTranslation && prevHash === inputHash) {
    return { sv: prevTranslation, hash: inputHash };
  }
  if (!AI_KEY) {
    return { sv: "", hash: inputHash, untranslated: true };
  }
  const sys = "Du är en professionell översättare som översätter Cardano-blockchain-innehåll från engelska till svenska. Behåll tekniska termer (DRep, stake, pool, ADA, Cardano, smart contract, blockchain, treasury, governance action, m.fl.) på engelska där de är vedertagna. Översätt kortfattat, sakligt och korrekt. Returnera ENDAST den svenska översättningen, ingen kommentar.";
  const user = `Översätt följande text till svenska:\n\n${text}`;
  try {
    const resp = await fetch(TRANSLATE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AI_KEY}`,
      },
      body: JSON.stringify({
        model: TRANSLATE_MODEL,
        max_tokens: 1024,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      console.error(`  translate failed (${resp.status}): ${err.slice(0,200)}`);
      return { sv: "", hash: inputHash, untranslated: true };
    }
    const data = await resp.json();
    const sv = (data.choices?.[0]?.message?.content || "").trim();
    return { sv, hash: inputHash };
  } catch (e) {
    console.error(`  translate error: ${e.message}`);
    return { sv: "", hash: inputHash, untranslated: true };
  }
}

// --- fetch Reddit JSON ------------------------------------------------------
async function fetchReddit(sub, limit = 6) {
  const url = `https://www.reddit.com/r/${sub}/hot.json?limit=${limit}`;
  const resp = await fetch(url, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`Reddit ${sub}: ${resp.status}`);
  const data = await resp.json();
  return data.data.children
    .filter((c) => !c.data.stickied)
    .map((c) => ({
      id: `reddit:${c.data.id}`,
      source: `r/${sub}`,
      title_en: c.data.title,
      summary_en: (c.data.selftext || "").slice(0, 400),
      url: `https://reddit.com${c.data.permalink}`,
      date: new Date(c.data.created_utc * 1000).toISOString(),
      score: c.data.score,
      comments: c.data.num_comments,
    }));
}

// --- fetch governance proposals from Koios ---------------------------------
async function fetchProposals(limit = 8) {
  const url = `https://api.koios.rest/api/v1/proposal_list?dropped_epoch=is.null&expired_epoch=is.null&enacted_epoch=is.null&order=expiration.desc&limit=${limit}`;
  const resp = await fetch(url, { headers: { "User-Agent": UA } });
  if (!resp.ok) throw new Error(`Koios proposals: ${resp.status}`);
  const list = await resp.json();
  return list.map((p) => {
    const meta = p.meta_json?.body || {};
    return {
      id: `gov:${p.proposal_id}`,
      proposal_id: p.proposal_id,
      type: p.proposal_type,
      proposed_epoch: p.proposed_epoch,
      expiration_epoch: p.expiration,
      title_en: (meta.title || "").trim() || `${p.proposal_type} proposal`,
      summary_en: (meta.abstract || "").trim().slice(0, 600),
      url: `https://gov.tools/governance_actions/${p.proposal_id}`,
      block_time: p.block_time ? new Date(p.block_time * 1000).toISOString() : null,
      deposit_ada: p.deposit ? Number(p.deposit) / 1_000_000 : null,
    };
  });
}

// --- merge new items with existing, retaining cached translations ----------
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
  let done = 0, skipped = 0;
  for (const it of items) {
    const t1 = await translateToSwedish(it.title_en, it.title_sv, it._title_sha);
    if (t1.sv) it.title_sv = t1.sv;
    if (t1.hash) it._title_sha = t1.hash;
    if (t1.untranslated) skipped++;

    const t2 = await translateToSwedish(it.summary_en, it.summary_sv, it._summary_sha);
    if (t2.sv) it.summary_sv = t2.sv;
    if (t2.hash) it._summary_sha = t2.hash;

    done++;
  }
  console.log(`  ${label}: translated ${done} item(s)${skipped ? `, ${skipped} skipped (no API key or failure)` : ""}`);
}

// --- main ------------------------------------------------------------------
async function main() {
  console.log(`fetch-content @ ${new Date().toISOString()}`);
  console.log(`AI Gateway key: ${AI_KEY ? "present" : "ABSENT (will store English only)"}`);

  // NEWS — combine multiple subreddits
  console.log("\n=== News ===");
  const newsFile = path.join(DATA_DIR, "news.json");
  const existingNews = loadJSON(newsFile)?.items || [];
  let news = [];
  for (const sub of ["cardano", "CardanoStakePools"]) {
    try {
      const items = await fetchReddit(sub, 6);
      console.log(`  r/${sub}: ${items.length} items`);
      news.push(...items);
    } catch (e) {
      console.error(`  r/${sub} failed: ${e.message}`);
    }
  }
  // dedupe + sort newest first
  const seen = new Set();
  news = news
    .filter((n) => !seen.has(n.id) && (seen.add(n.id), true))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 10);
  news = mergeItems(existingNews, news);
  await translateItems(news, "news");
  saveJSON(newsFile, { fetched_at: new Date().toISOString(), items: news });
  console.log(`  wrote ${newsFile}`);

  // PROPOSALS
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
  props = mergeItems(existingProps, props);
  await translateItems(props, "proposals");
  saveJSON(propsFile, { fetched_at: new Date().toISOString(), items: props });
  console.log(`  wrote ${propsFile}`);

  console.log("\nDone.");
}

await main();
