// Hold'em hand evaluator and insurance outs. Cards are 0–51: rank = c >> 2 (0 = 2 … 12 = A), suit = c & 3.
export const RANKS = '23456789TJQKA';
export const SUITS = ['s', 'h', 'd', 'c'];
export const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
export const card = (rank, suit) => RANKS.indexOf(rank) * 4 + SUITS.indexOf(suit);
export const cardName = (c) => RANKS[c >> 2] + SUITS[c & 3];
export const parseCard = (s) => { const r = RANKS.indexOf(String(s)[0]?.toUpperCase()), u = SUITS.indexOf(String(s)[1]?.toLowerCase()); return r < 0 || u < 0 ? null : r * 4 + u; };
const CATEGORY = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];
export const CATEGORY_ZH = ['高牌', '一對', '兩對', '三條', '順子', '同花', '葫蘆', '四條', '同花順'];

// Score of exactly 5 cards: higher is better; equal scores split the pot.
function score5(cs) {
  const r = cs.map((c) => c >> 2).sort((a, b) => b - a);
  const flush = cs.every((c) => (c & 3) === (cs[0] & 3));
  const uniq = [...new Set(r)];
  let straightHigh = -1;
  if (uniq.length === 5) {
    if (r[0] - r[4] === 4) straightHigh = r[0];
    else if (r[0] === 12 && r[1] === 3) straightHigh = 3; // A-2-3-4-5
  }
  const cnt = new Map(); r.forEach((x) => cnt.set(x, (cnt.get(x) || 0) + 1));
  const groups = [...cnt.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const kick = (list) => list.reduce((s, x) => s * 13 + x, 0);
  let cat, ks;
  if (straightHigh >= 0 && flush) { cat = 8; ks = [straightHigh]; }
  else if (groups[0][1] === 4) { cat = 7; ks = [groups[0][0], groups[1][0]]; }
  else if (groups[0][1] === 3 && groups[1][1] === 2) { cat = 6; ks = [groups[0][0], groups[1][0]]; }
  else if (flush) { cat = 5; ks = r; }
  else if (straightHigh >= 0) { cat = 4; ks = [straightHigh]; }
  else if (groups[0][1] === 3) { cat = 3; ks = groups.map((g) => g[0]); }
  else if (groups[0][1] === 2 && groups[1][1] === 2) { cat = 2; ks = groups.map((g) => g[0]); }
  else if (groups[0][1] === 2) { cat = 1; ks = groups.map((g) => g[0]); }
  else { cat = 0; ks = r; }
  while (ks.length < 5) ks.push(0);
  return cat * 13 ** 5 + kick(ks);
}

// Best 5 of 5–7 cards.
export function best(cards) {
  let top = -1;
  const n = cards.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
    const s = score5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
    if (s > top) top = s;
  }
  return top;
}
export const category = (score) => Math.floor(score / 13 ** 5);
export const categoryName = (score, zh) => (zh ? CATEGORY_ZH : CATEGORY)[category(score)];

// One pot: who leads now, and which next cards let an opponent pass the leader (a tie is not an out).
// hands: { [player]: [c1, c2] } for the players in this pot; board: 3 (flop) or 4 (turn) cards; dead: every other known card.
export function potOuts(hands, board, dead = []) {
  const ids = Object.keys(hands);
  const now = Object.fromEntries(ids.map((p) => [p, best([...hands[p], ...board])]));
  const top = Math.max(...ids.map((p) => now[p]));
  const leaders = ids.filter((p) => now[p] === top);
  const known = new Set([...ids.flatMap((p) => hands[p]), ...board, ...dead]);
  const unseen = [];
  for (let c = 0; c < 52; c++) if (!known.has(c)) unseen.push(c);
  if (leaders.length > 1) return { leader: null, tied: leaders, now, outs: [], unseen: unseen.length };
  const leader = leaders[0];
  const outs = [];
  for (const c of unseen) {
    const mine = best([...hands[leader], ...board, c]);
    const passer = ids.find((p) => p !== leader && best([...hands[p], ...board, c]) > mine);
    if (passer) outs.push({ card: c, by: passer });
  }
  return { leader, tied: [], now, outs, unseen: unseen.length };
}

// Odds and the most that can be bought for one pot.
export function quote({ odds, cap_bb, chip }, players, outs, pot, bb) {
  if (!outs) return { ok: false, reason: 'none' };
  if (outs > 15) return { ok: false, reason: 'too_many' };
  const x = odds[players] && odds[players][outs - 1];
  if (!x) return { ok: false, reason: 'players' };
  const cap = cap_bb * bb;
  const max = pot > 0 && bb > 0 ? Math.floor(Math.min(pot, cap) / x / chip) * chip : 0;
  return { ok: true, odds: x, max, cap, capped: pot > cap };
}
