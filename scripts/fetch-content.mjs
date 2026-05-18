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
 *   AI_GATEWAY_API_KEY  — Vercel AI Gateway key. Optional. If absent,
 *                         items are stored with raw English text only.
 *   TRANSLATE_MODEL     — Override model. Default openai/gpt-5-nano.
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

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 12);
const loadJSON = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const saveJSON = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");

// --- translation via AI Gateway --------------------------------------------
async function translateToSwedish(text, prevTranslation, prevHash) {
  if (!text || !text.trim()) return { sv: "", hash: "" };
  const inputHash = sha(text);
  if (prevTranslation && prevHash === inputHash) {
    return { sv: prevTranslation, hash: inputHash };
  }
  if (!AI_KEY) {
    return { sv: "", hash: inputHash, untranslated: true };
  }
  const sys = "Du är en professionell översättare som översätter Cardano-blockchain-innehåll från engelska till svenska. Behåll tekniska termer (DRep, stake, pool, ADA, Cardano, smart contract, blockchain, treasury, governance action, m.fl.) på engelska där de är vedertagna. Översätt kortfattat, sakligt och korrekt. Returnera ENDAST den svenska översättningen, ingen kommentar, ingen formatering.";
  const user = `Översätt följande text till svenska:\n\n${text}`;
  try {
    const body = {
      model: TRANSLATE_MODEL,
      max_tokens: 4096,
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
    const resp = await fetch(TRANSLATE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AI_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      console.error(`  translate failed (${resp.status}): ${err.slice(0,200)}`);
      return { sv: "", hash: inputHash, untranslated: true };
    }
    const data = await resp.json();
    const sv = (data.choices?.[0]?.message?.content || "").trim();
    if (!sv) {
      const fr = data.choices?.[0]?.finish_reason || "?";
      const u = data.usage || {};
      console.error(`  translate empty: finish=${fr} prompt=${u.prompt_tokens} completion=${u.completion_tokens} reasoning=${u.completion_tokens_details?.reasoning_tokens}`);
    }
    return { sv, hash: inputHash };
  } catch (e) {
    console.error(`  translate error: ${e.message}`);
    return { sv: "", hash: inputHash, untranslated: true };
  }
}

// --- news source 1: Cardano Forum (Discourse JSON API) ---------------------
async function fetchCardanoForum(limit = 8) {
  const url = "https://forum.cardano.org/latest.json?order=created";
  const resp = await fetch(url, {
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
  const resp = await fetch("https://adapulse.io/feed/", {
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

// --- governance proposals from Koios ---------------------------------------
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
  console.log(`fetch-content @ ${new Date().toISOString()} model=${TRANSLATE_MODEL}`);
  console.log(`AI Gateway key: ${AI_KEY ? "present" : "ABSENT (English only)"}`);

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
  props = mergeItems(existingProps, props);
  await translateItems(props, "proposals");
  saveJSON(propsFile, { fetched_at: new Date().toISOString(), items: props });

  console.log("\nDone.");
}

await main();
