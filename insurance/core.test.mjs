import assert from 'node:assert/strict';
import { parseCard as P, best, potOuts, quote, cardName, categoryName } from './core.js';
const H = (...s) => s.map(P);
// Rankings
const s = (x) => best(H(...x.split(' ')));
assert.ok(s('Ah Kh Qh Jh Th') > s('9s 9h 9d 9c Ah'), 'royal > quads');
assert.ok(s('5d 4d 3d 2d Ad') < s('6c 5c 4c 3c 2c'), 'wheel SF < 6-high SF');
assert.ok(s('As 2d 3c 4h 5s') < s('2s 3d 4c 5h 6s'), 'wheel straight is the lowest');
assert.ok(s('Kh Kd Ks 2c 2d') > s('Qh Qd Qs Ac Ad'), 'full house by trips');
assert.equal(s('Ah Kd 7c 5s 2h 9d 3c'), s('Ah Kd 9d 7c 5s'), 'best 5 of 7');
assert.equal(categoryName(s('Ah Ad Kc Ks 2h')), 'Two pair');
// Classic flush draw vs overpair on the turn: 9 hearts minus none blocking → 9 outs
{
  const r = potOuts({ A: H('As', 'Ad'), B: H('Kh', 'Qh') }, H('2h', '7h', '9c', '3d'));
  assert.equal(r.leader, 'A');
  assert.equal(r.outs.length, 9 + 0, 'nine hearts'); // K and Q don't beat aces (pair of K < AA)
  assert.ok(r.outs.every((o) => o.by === 'B'));
}
// Chop is not an out: AK vs AQ on A-K-x? use board where Q gives a split straight
{
  const r = potOuts({ A: H('Ac', 'Kc'), B: H('Ad', 'Qd') }, H('As', '7h', '2c', '9s'));
  // B needs Q: two pair AQ vs AK pair? AK has A+K kicker; Q gives B A-A-Q-Q? no: B gets two pair AQ > A with K kicker → out. 3 Qs left.
  assert.equal(r.leader, 'A'); assert.deepEqual(r.outs.map((o) => cardName(o.card)).sort(), ['Qc', 'Qh', 'Qs']);
}
{ // a card that only ties is not counted: any 4 gives both players the wheel
  const r = potOuts({ A: H('As', 'Ks'), B: H('Ad', 'Qd') }, H('Ah', '7c', '2s', '3h'));
  const outs = r.outs.map((o) => cardName(o.card));
  assert.equal(r.leader, 'A');
  assert.ok(!outs.some((c) => c[0] === '4'), 'tie card is not an out');
  assert.deepEqual(outs.sort(), ['Qc', 'Qh', 'Qs']);
}
// 3-way: outs from either opponent, counted once
{
  const r = potOuts({ A: H('As', 'Ad'), B: H('Kh', 'Qh'), C: H('8c', '8d') }, H('2h', '7h', '9c', '3d'));
  assert.equal(r.leader, 'A'); assert.equal(r.outs.length, 9 + 1, 'nine hearts + the last 8');
}
// Tied leaders: no insurance
assert.equal(potOuts({ A: H('Ah', 'Kd'), B: H('Ad', 'Kc') }, H('2h', '7s', '9c', '3d')).leader, null);
// Flop: next card only, unseen 45 for 2 players
assert.equal(potOuts({ A: H('As', 'Ad'), B: H('Kh', 'Qh') }, H('2h', '7h', '9c')).unseen, 45);
// Quote
const cfg = { odds: { 2: [30, 15, 10, 8, 6, 5, 4, 3.5, 3, 2.5, 2.2, 2, 1.8, 1.6, 1.4] }, cap_bb: 1000, chip: 25 };
assert.deepEqual(quote(cfg, 2, 8, 30000, 100), { ok: true, odds: 3.5, max: 8550, cap: 100000, capped: false });
assert.equal(quote(cfg, 2, 1, 300000, 100).max, 3325, 'capped at 1000 BB = 100,000 → 100000/30 = 3333 → 3325');
assert.equal(quote(cfg, 2, 16, 30000, 100).reason, 'too_many');
console.log('PASS insurance core: rankings, outs (ties excluded, multiway), quotes and cap');
