import React, { useEffect, useMemo, useState } from "react";

/**
 * WAR AT SEA — DECKBUILDER v1 (patched)
 * -------------------------------------------------
 * Changes in this patch:
 * - Handles Supabase magic-link rate limit (HTTP 429 over_email_send_rate_limit)
 * - Disables the Sign-in button with a live countdown (seconds) until retry
 * - Stores cooldown in localStorage so refreshes keep the timer
 * - Friendlier error messages (no raw JSON dump)
 * - Tiny test cases for the wait-time parser (see console)
 *
 * What you get in this single file:
 * - Email sign-in with Supabase (magic link)
 * - Pulls data from: units, unit_stats
 * - If logged in, also reads user_ownership to enforce Owned/Copies
 * - Point-cap presets (50/80/110/150/200/250) — default 150
 * - Faction rule: Axis-only / Allies-only / Mixed — default Axis-only
 * - Owned-only toggle ON by default; disabled if not logged in
 * - Filter by Nation, Type, text search
 * - Add/remove items with per-unit Copies cap
 * - Live totals: points, counts, and summed effective damage by range (0-3)
 * - Save deck to Supabase (decks, deck_units)
 *
 * Setup — fill these two from your Supabase project (Settings → API):
 */
// Read from Vite env vars in production; fall back to globals if needed
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || window?.__SUPABASE_URL__; // set in Vercel → Env Vars
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || window?.__SUPABASE_ANON_KEY__; // set in Vercel → Env Vars

// -------------- helpers (HTTP + auth) --------------
const rest = async (path, init = {}) => {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    Accept: "application/json",
    ...init.headers,
  };
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
};

/** Extract seconds to wait from a Supabase error message. */
function parseWaitSeconds(msg) {
  if (!msg || typeof msg !== "string") return null;
  // e.g. "For security purposes, you can only request this after 54 seconds."
  const m = msg.match(/(\d+)\s*(?:second|sec|s)\b/i);
  if (m) return parseInt(m[1], 10);
  // If the message says "1 minute" etc., convert to seconds
  const m2 = msg.match(/(\d+)\s*(?:minute|min|m)\b/i);
  if (m2) return parseInt(m2[1], 10) * 60;
  return null;
}

// Tiny test cases (printed in console)
console.assert(parseWaitSeconds("after 54 seconds") === 54, "parseWaitSeconds #1");
console.assert(parseWaitSeconds("wait 1 minute") === 60, "parseWaitSeconds #2");
console.assert(parseWaitSeconds("") === null, "parseWaitSeconds #3");

function formatError(e) {
  try {
    if (!e) return "Unknown error";
    if (typeof e === "string") return e;
    if (e.msg) return e.msg;
    if (e.message) return e.message;
    return JSON.stringify(e);
  } catch { return "Unknown error"; }
}

// Supabase GoTrue (magic link) with friendly errors + rate-limit info
// Supabase GoTrue (magic link) with friendly errors + rate-limit info
const auth = {
  signInMagic: async (email) => {
    // Always send an explicit redirect URL so the magic link doesn't default to localhost:3000
    const REDIRECT = `${window.location.origin}/`; // e.g. http://localhost:5173/
    const body = {
      email,
      create_user: true,
      // Works with newer GoTrue: options.email_redirect_to
      options: { email_redirect_to: REDIRECT },
      // Works with older versions too: redirect_to at top-level
      redirect_to: REDIRECT,
    };

    const res = await fetch(`${SUPABASE_URL}/auth/v1/magiclink`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      let payload = {};
      try { payload = JSON.parse(text); } catch { payload = { msg: text }; }
      const err = new Error(payload.msg || "Sign-in failed");
      err.code = res.status;
      err.error_code = payload.error_code;
      err.wait = parseWaitSeconds(payload.msg);
      throw err;
    }
  },
  getUser: async (accessToken) => {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    if (!res.ok) return null;
    return await res.json();
  },
};

// -------------- constants --------------
const POINT_CAPS = [50, 80, 110, 150, 200, 250];
const DEFAULT_CAP = 150;
const DEFAULT_RULE = "axis_only"; // axis_only | allies_only | mixed

function classNames(...xs) {
  return xs.filter(Boolean).join(" ");
}

export default function App() {
  const [session, setSession] = useState(null); // {access_token, user}
  const [email, setEmail] = useState("");

  const [units, setUnits] = useState([]); // joined units + stats
  const [ownership, setOwnership] = useState({}); // unit_id -> {owned, copies}

  const [pointCap, setPointCap] = useState(DEFAULT_CAP);
  const [factionRule, setFactionRule] = useState(DEFAULT_RULE); // axis_only | allies_only | mixed
  const [ownedOnly, setOwnedOnly] = useState(true);

  const [q, setQ] = useState("");
  const [nation, setNation] = useState("All");
  const [type, setType] = useState("All");

  const [deck, setDeck] = useState({}); // unit_id -> count
  const [deckName, setDeckName] = useState("My Axis 150");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  // Rate-limit state (magic link)
  const [cooldownUntil, setCooldownUntil] = useState(() => {
    const t = Number(localStorage.getItem("magic_cooldown_until") || 0);
    return t || 0;
  });
  const [cooldownLeft, setCooldownLeft] = useState(0);

  useEffect(() => {
    let id;
    const tick = () => {
      const left = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
      setCooldownLeft(left);
      if (left === 0 && id) { clearInterval(id); id = undefined; }
    };
    if (cooldownUntil > Date.now()) {
      tick();
      id = setInterval(tick, 1000);
    } else {
      setCooldownLeft(0);
    }
    return () => { if (id) clearInterval(id); };
  }, [cooldownUntil]);  // pick up access token from URL hash or query (magic link flow)
  useEffect(() => {
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, "?"));
    const fromQuery = new URLSearchParams(window.location.search);
    const token = fromHash.get("access_token") || fromQuery.get("access_token");
    if (token) {
      auth.getUser(token).then((user) => {
        if (user) setSession({ access_token: token, user });
      }).catch(console.error);
    }
  }, []);

  // load units + stats
  useEffect(() => {
    (async () => {
      try {
        const u = await rest("units?select=id,name,nation,type,year,points,set_name,rarity,abilities");
        const s = await rest("unit_stats?select=*&limit=10000");
        const sMap = new Map(s.map((r) => [r.unit_id, r]));
        const merged = u.map((x) => ({ ...x, stats: sMap.get(x.id) || {} }));
        setUnits(merged);
      } catch (e) {
        setError(formatError(e));
      }
    })();
  }, []);

  // load ownership if logged in
  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/user_ownership?select=unit_id,owned,copies`, {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session.access_token}`,
          },
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        const map = {}; data.forEach((r) => { map[r.unit_id] = r; });
        setOwnership(map);
      } catch (e) { setError(formatError(e)); }
    })();
  }, [session]);

  // derived filters
  const nations = useMemo(() => ["All", ...Array.from(new Set(units.map(u => u.nation).filter(Boolean))).sort()], [units]);
  const types = useMemo(() => ["All", ...Array.from(new Set(units.map(u => u.type).filter(Boolean))).sort()], [units]);

  const filtered = useMemo(() => {
    let list = units;
    if (q) {
      const qq = q.toLowerCase();
      list = list.filter(u => u.name?.toLowerCase().includes(qq) || u.abilities?.toLowerCase().includes(qq));
    }
    if (nation !== "All") list = list.filter(u => u.nation === nation);
    if (type !== "All") list = list.filter(u => u.type === type);

    if (factionRule !== "mixed") {
      const axis = new Set(["Germany","Italy","Japan","Finland","Romania","Hungary","Bulgaria","Axis"]);
      const allies = new Set(["USA","United States","United Kingdom","UK","Britain","Soviet Union","USSR","France","Canada","Netherlands","Poland","Australia","New Zealand","Greece","Norway","Allies"]);
      list = list.filter(u => factionRule === "axis_only" ? axis.has(u.nation) : allies.has(u.nation));
    }

    if (ownedOnly) {
      list = list.filter(u => (ownership[u.id]?.owned) || (ownership[u.id]?.copies > 0));
    }
    return list;
  }, [units, q, nation, type, factionRule, ownedOnly, ownership]);

  // deck derived values
  const deckItems = useMemo(() => Object.entries(deck).map(([unit_id, count]) => {
    const u = units.find(x => x.id === unit_id);
    return { unit: u, count };
  }).filter(x => x.unit), [deck, units]);

  const deckPoints = useMemo(() => deckItems.reduce((acc, { unit, count }) => acc + (unit.points||0) * count, 0), [deckItems]);

  const effectiveSumByRange = useMemo(() => {
    const ranges = [0,1,2,3];
    const out = { 0:0,1:0,2:0,3:0 };
    for (const { unit, count } of deckItems) {
      const st = unit.stats || {};
      ranges.forEach(r => {
        const v = Number(st[`effective_gunnerytotal_${r}`] || 0);
        out[r] += v * count;
      });
    }
    return out;
  }, [deckItems]);

  const factionOfDeck = useMemo(() => {
    const nationsInDeck = new Set(deckItems.map(x => x.unit.nation));
    const axis = new Set(["Germany","Italy","Japan","Finland","Romania","Hungary","Bulgaria","Axis"]);
    const allies = new Set(["USA","United States","United Kingdom","UK","Britain","Soviet Union","USSR","France","Canada","Netherlands","Poland","Australia","New Zealand","Greece","Norway","Allies"]);
    const allAxis = [...nationsInDeck].every(n => axis.has(n));
    const allAllies = [...nationsInDeck].every(n => allies.has(n));
    return allAxis ? "Axis" : allAllies ? "Allies" : "Mixed";
  }, [deckItems]);

  // actions
  async function onMagicSubmit(e) {
    e.preventDefault();
    setError(""); setOk("");
    if (!email) { setError("Enter an email first"); return; }
    if (cooldownLeft > 0) { setError(`Please wait ${cooldownLeft}s before requesting another link.`); return; }
    try {
      await auth.signInMagic(email);
      setOk("Magic link sent. Check your email.");
    } catch (e) {
      if (e.code === 429 || e.error_code === 'over_email_send_rate_limit') {
        const wait = e.wait ?? 60; // Supabase said 54s, default to 60 if unknown
        const until = Date.now() + wait * 1000;
        localStorage.setItem('magic_cooldown_until', String(until));
        setCooldownUntil(until);
        setError(`Too many requests. Try again in ${wait}s.`);
      } else {
        setError(formatError(e));
      }
    }
  }

  function addToDeck(u) {
    const maxCopies = ownership[u.id]?.copies ?? 99;
    setDeck(prev => {
      const cur = prev[u.id] || 0;
      if (cur >= maxCopies) return prev; // cap
      const next = { ...prev, [u.id]: cur + 1 };
      return next;
    });
  }
  function removeFromDeck(u) {
    setDeck(prev => {
      const cur = prev[u.id] || 0;
      if (cur <= 1) { const { [u.id]:_, ...rest } = prev; return rest; }
      return { ...prev, [u.id]: cur - 1 };
    });
  }
  function clearDeck() { setDeck({}); }

  async function saveDeck() {
    try {
      setSaving(true); setError(""); setOk("");
      if (!session) throw new Error("Sign in first (magic link)");
      if (deckPoints > pointCap) throw new Error("Deck exceeds point cap");
      if (factionRule === "axis_only" && factionOfDeck !== "Axis") throw new Error("Deck violates Axis-only rule");
      if (factionRule === "allies_only" && factionOfDeck !== "Allies") throw new Error("Deck violates Allies-only rule");

      const deckRes = await fetch(`${SUPABASE_URL}/rest/v1/decks`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          user_id: session.user.id,
          name: deckName,
          description: `${factionOfDeck} deck — ${deckPoints}/${pointCap} pts`,
          point_cap: pointCap,
          faction_rule: factionRule,
          visibility: "private",
        }),
      });
      if (!deckRes.ok) throw new Error(await deckRes.text());
      const [deckRow] = await deckRes.json();

      const payload = Object.entries(deck).map(([unit_id, count]) => ({ deck_id: deckRow.id, unit_id, count }));
      if (payload.length) {
        const du = await fetch(`${SUPABASE_URL}/rest/v1/deck_units`, {
          method: "POST",
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates",
          },
          body: JSON.stringify(payload),
        });
        if (!du.ok) throw new Error(await du.text());
      }

      setOk("Deck saved");
    } catch (e) { setError(formatError(e)); }
    finally { setSaving(false); }
  }

  // basic recommend: greedily add best effective damage per point under constraints
  function recommend() {
    let pool = filtered.slice();
    const scored = pool.map(u => {
      const st = u.stats || {}; const eff = [0,1,2,3].map(r => Number(st[`effective_gunnerytotal_${r}`]||0));
      const score = (eff[0]+eff[1]+eff[2]+eff[3]) / Math.max(1, u.points||1);
      return { u, score };
    }).sort((a,b)=>b.score-a.score);

    const next = {}; let pts = 0;
    for (const {u} of scored) {
      const limit = ownership[u.id]?.copies ?? 99;
      while (pts + (u.points||0) <= pointCap) {
        const cur = next[u.id]||0; if (cur >= limit) break;
        next[u.id] = cur+1; pts += (u.points||0);
        if (pointCap-pts < 3) break;
      }
      if (pts >= pointCap-1) break;
    }
    setDeck(next);
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">War at Sea — Deckbuilder v1</h1>
        <div className="flex items-center gap-2">
          {!session ? (
            <form className="flex gap-2" onSubmit={onMagicSubmit}>
              <input className="px-3 py-2 rounded bg-neutral-800 border border-neutral-700" placeholder="email for magic link" value={email} onChange={e=>setEmail(e.target.value)} />
              <button disabled={!email || cooldownLeft>0} className={classNames("px-3 py-2 rounded", cooldownLeft>0?"bg-neutral-800 border border-neutral-700 opacity-60":"bg-blue-600 hover:bg-blue-500")}>{cooldownLeft>0?`Wait ${cooldownLeft}s`:"Sign in"}</button>
            </form>
          ) : (
            <div className="text-sm opacity-80">signed in as <span className="font-mono">{session.user.email}</span></div>
          )}
        </div>
      </header>

      <section className="mt-4 grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-1 space-y-3">
          <div className="p-4 rounded-2xl bg-neutral-900 border border-neutral-800 space-y-3">
            <div className="font-semibold">Rules</div>
            <div className="flex flex-wrap gap-2">
              {POINT_CAPS.map(c => (
                <button key={c} onClick={()=>setPointCap(c)} className={classNames("px-3 py-1 rounded-full border", pointCap===c?"bg-white text-black border-white":"border-neutral-700 bg-neutral-800")}>{c}</button>
              ))}
            </div>
            <div className="flex gap-2">
              <select className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1" value={factionRule} onChange={e=>setFactionRule(e.target.value)}>
                <option value="axis_only">Axis-only</option>
                <option value="allies_only">Allies-only</option>
                <option value="mixed">Mixed</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={ownedOnly} onChange={e=>setOwnedOnly(e.target.checked)} disabled={!session} />
              Owned only (login required)
            </label>
          </div>

          <div className="p-4 rounded-2xl bg-neutral-900 border border-neutral-800 space-y-3">
            <div className="font-semibold">Filters</div>
            <input className="w-full px-3 py-2 rounded bg-neutral-800 border border-neutral-700" placeholder="search name or ability" value={q} onChange={e=>setQ(e.target.value)} />
            <select className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-2" value={nation} onChange={e=>setNation(e.target.value)}>
              {nations.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
            <select className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-2" value={type} onChange={e=>setType(e.target.value)}>
              {types.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <div className="flex gap-2">
              <button className="flex-1 px-3 py-2 rounded bg-neutral-800 border border-neutral-700" onClick={()=>{setQ("");setNation("All");setType("All");}}>Reset</button>
              <button className="flex-1 px-3 py-2 rounded bg-emerald-600 hover:bg-emerald-500" onClick={recommend}>Recommend</button>
            </div>
            {cooldownLeft>0 && (
              <div className="text-xs opacity-70">You can request a new magic link in {cooldownLeft}s.</div>
            )}
          </div>
        </div>

        <div className="lg:col-span-3 grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div className="p-4 rounded-2xl bg-neutral-900 border border-neutral-800">
            <div className="flex items-center justify-between mb-2">
              <div className="font-semibold">Available Units ({filtered.length})</div>
            </div>
            <div className="h-[520px] overflow-auto divide-y divide-neutral-800">
              {filtered.map(u => {
                const maxCopies = ownership[u.id]?.copies ?? 99;
                const inDeck = deck[u.id] || 0;
                const disabled = (inDeck >= maxCopies) || (deckPoints + (u.points||0) > pointCap) || (factionRule!=="mixed" && deckItems.length>0 && factionOfDeck!==(factionRule==="axis_only"?"Axis":"Allies"));
                return (
                  <div key={u.id} className="py-3 flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{u.name} <span className="opacity-60 text-sm">({u.nation} · {u.type})</span></div>
                      <div className="text-xs opacity-70">Pts {u.points} · Abilities: {u.abilities || '—'}</div>
                      <div className="text-xs opacity-70">Eff(0–3): {[0,1,2,3].map(r=>Number(u.stats?.[`effective_gunnerytotal_${r}`]||0).toFixed(2)).join(" / ")}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button disabled={disabled} onClick={()=>addToDeck(u)} className={classNames("px-2 py-1 rounded border", disabled?"opacity-40 cursor-not-allowed border-neutral-800":"bg-neutral-800 border-neutral-700")}>+ Add</button>
                      <div className="text-sm w-8 text-center">{inDeck}</div>
                      <button disabled={!inDeck} onClick={()=>removeFromDeck(u)} className={classNames("px-2 py-1 rounded border", !inDeck?"opacity-40 cursor-not-allowed border-neutral-800":"bg-neutral-800 border-neutral-700")}>−</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="p-4 rounded-2xl bg-neutral-900 border border-neutral-800">
            <div className="flex items-center justify-between gap-2">
              <input className="flex-1 px-3 py-2 rounded bg-neutral-800 border border-neutral-700" value={deckName} onChange={e=>setDeckName(e.target.value)} />
            </div>
            <div className="mt-3 text-sm opacity-80">Faction: {factionOfDeck} · Points: {deckPoints} / {pointCap}</div>
            <div className="mt-2 text-xs opacity-70">Effective total by range 0–3: {Object.values(effectiveSumByRange).map(v=>v.toFixed(2)).join(" / ")}</div>
            <div className="mt-3 h-[360px] overflow-auto divide-y divide-neutral-800">
              {deckItems.length===0 && <div className="opacity-60 text-sm">No units yet. Add from the left.</div>}
              {deckItems.map(({unit, count}) => (
                <div key={unit.id} className="py-2 flex items-center justify-between">
                  <div>
                    <div className="font-medium">{unit.name}</div>
                    <div className="text-xs opacity-70">{unit.nation} · {unit.type} · {unit.points} pts × {count}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button className="px-2 py-1 rounded bg-neutral-800 border border-neutral-700" onClick={()=>removeFromDeck(unit)}>−</button>
                    <span className="w-8 text-center">{count}</span>
                    <button className="px-2 py-1 rounded bg-neutral-800 border border-neutral-700" onClick={()=>addToDeck(unit)}>+</button>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={clearDeck} className="px-3 py-2 rounded bg-neutral-800 border border-neutral-700">Clear</button>
              <button onClick={saveDeck} disabled={saving || !session} className={classNames("px-3 py-2 rounded", saving||!session?"bg-neutral-800 border border-neutral-700 opacity-60":"bg-emerald-600 hover:bg-emerald-500")}>{saving?"Saving…":"Save deck"}</button>
            </div>
            {error && <div className="mt-2 text-red-400 text-sm">{error}</div>}
            {ok && <div className="mt-2 text-emerald-400 text-sm">{ok}</div>}
          </div>
        </div>
      </section>

      <footer className="mt-6 text-xs opacity-60">
        Defaults: cap 150 · rule Axis-only · owned-only ON (requires login). Paste your new Anon key at the top. Magic link requests are rate-limited; if you hit it, the button will show a countdown.<br/>
        Tip: In Supabase → Authentication → URL Configuration, add this origin to Allowed Redirect URLs: <code>{window.location.origin}/*</code>.
      </footer>
    </div>
  );
}
