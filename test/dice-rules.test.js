const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDice, eligibleDicePlayers, recordDiceRoll, dicePayouts } = require('../dice');

const players = ['PPR-A', 'PPR-B', 'PPR-C', 'PPR-D'];
function round(state, rolls, mode = 'shared') {
  let result;
  const count = state.groups.flat().length;
  for (const [accountId, value] of Object.entries(rolls)) {
    result = recordDiceRoll(state, accountId, value, mode, count);
    state = result.state;
  }
  return result;
}
const amounts = payouts => payouts.map(payout => payout.amount);
const total = payouts => payouts.reduce((sum, payout) => sum + BigInt(payout.amount), 0n);

test('dice starts with two to four distinct permanent player IDs', () => {
  const ids = players.slice(0, 3);
  const state = createDice(ids);
  ids.reverse();
  assert.deepEqual(state, { round: 1, groups: [players.slice(0, 3)], rolls: {}, history: [] });
  for (const invalid of [null, [], ['A'], [...players, 'E'], ['A', 'A'], ['A', null], ['A', '']]) {
    assert.throws(() => createDice(invalid), TypeError);
  }
});

test('any player may roll first, and results wait for every eligible player', () => {
  const state = createDice(players.slice(0, 3));
  const before = JSON.stringify(state);
  const first = recordDiceRoll(state, players[2], 3, 'shared', 3);
  assert.equal(JSON.stringify(state), before);
  assert.equal(first.complete, false);
  assert.equal(first.winnerAccountId, null);
  assert.deepEqual(first.placements, []);
  assert.deepEqual(first.state.history, []);
  assert.deepEqual(eligibleDicePlayers(first.state, 'shared', 3), players.slice(0, 2));
  assert.throws(() => recordDiceRoll(first.state, players[2], 6, 'shared', 3), RangeError);
  const done = round(first.state, { [players[1]]: 5, [players[0]]: 1 });
  assert.equal(done.complete, true);
  assert.deepEqual(done.placements, [players[1], players[2], players[0]]);
  assert.deepEqual(done.state.history, [{ round: 1, groups: [players.slice(0, 3)],
    rolls: { [players[2]]: 3, [players[1]]: 5, [players[0]]: 1 } }]);
  assert.deepEqual(eligibleDicePlayers(done.state, 'shared', 3), []);
  assert.throws(() => recordDiceRoll(done.state, players[0], 6, 'shared', 3), RangeError);
});

test('all two-player rolls pay the higher die or refund a tie, regardless of click order', () => {
  for (let a = 1; a <= 6; a += 1) for (let b = 1; b <= 6; b += 1) {
    for (const ids of [players.slice(0, 2), players.slice(0, 2).reverse()]) {
      const values = { [players[0]]: a, [players[1]]: b };
      const result = round(createDice(players.slice(0, 2)), Object.fromEntries(ids.map(id => [id, values[id]])));
      assert.equal(result.complete, true);
      assert.equal(result.draw, a === b);
      assert.equal(result.winnerAccountId, a === b ? null : a > b ? players[0] : players[1]);
      const payouts = dicePayouts(result.placements, 9, 'shared', result);
      assert.equal(total(payouts), 18n);
      assert.deepEqual(amounts(payouts), a === b ? [9, 9] : [18, 0]);
    }
  }
});

test('an initial all-player tie refunds shared three- and four-player matches', () => {
  for (const count of [3, 4]) for (let die = 1; die <= 6; die += 1) {
    const ids = players.slice(0, count);
    const result = round(createDice(ids), Object.fromEntries(ids.map(id => [id, die])));
    assert.equal(result.complete, true);
    assert.equal(result.draw, true);
    assert.equal(result.winnerAccountId, null);
    assert.deepEqual(amounts(dicePayouts(result.placements, 7, 'shared', result)), Array(count).fill(7));
    assert.deepEqual(eligibleDicePlayers(result.state, 'shared', count), []);
  }
});

test('a tied pair of leaders keeps first and second place above the frozen third player', () => {
  const tied = round(createDice(players.slice(0, 3)), { [players[0]]: 6, [players[1]]: 6, [players[2]]: 3 });
  assert.equal(tied.complete, false);
  assert.equal(tied.state.round, 2);
  assert.deepEqual(tied.state.groups, [[players[0], players[1]], [players[2]]]);
  assert.deepEqual(eligibleDicePlayers(tied.state, 'shared', 3), players.slice(0, 2));
  assert.throws(() => recordDiceRoll(tied.state, players[2], 6, 'shared', 3), RangeError);
  const done = round(tied.state, { [players[0]]: 1, [players[1]]: 2 });
  assert.deepEqual(done.placements, [players[1], players[0], players[2]]);
  assert.deepEqual(amounts(dicePayouts(done.placements, 10, 'shared', done)), [20, 10, 0]);
});

test('rerolling tied last places cannot overtake a frozen winner', () => {
  const tied = round(createDice(players.slice(0, 3)), { [players[0]]: 2, [players[1]]: 1, [players[2]]: 1 });
  const done = round(tied.state, { [players[1]]: 6, [players[2]]: 5 });
  assert.deepEqual(done.placements, [players[0], players[1], players[2]]);
});

test('two independent tied pairs resolve within their original place groups', () => {
  const tied = round(createDice(players), { [players[0]]: 6, [players[1]]: 6, [players[2]]: 2, [players[3]]: 2 });
  assert.deepEqual(tied.state.groups, [players.slice(0, 2), players.slice(2)]);
  const first = recordDiceRoll(tied.state, players[1], 1, 'shared', 4);
  const second = recordDiceRoll(first.state, players[0], 2, 'shared', 4);
  assert.equal(second.complete, false);
  assert.deepEqual(eligibleDicePlayers(second.state, 'shared', 4), players.slice(2));
  const done = round(second.state, { [players[2]]: 6, [players[3]]: 5 });
  assert.deepEqual(done.placements, players);
});

test('a three-way tie can split into another tied pair and repeat indefinitely', () => {
  const tied = round(createDice(players), { [players[0]]: 6, [players[1]]: 6, [players[2]]: 6, [players[3]]: 5 });
  const split = round(tied.state, { [players[0]]: 1, [players[1]]: 4, [players[2]]: 4 });
  assert.deepEqual(split.state.groups, [[players[1], players[2]], [players[0]], [players[3]]]);
  assert.equal(split.state.round, 3);
  const repeat = round(split.state, { [players[1]]: 2, [players[2]]: 2 });
  assert.equal(repeat.draw, false);
  assert.equal(repeat.complete, false);
  assert.equal(repeat.state.round, 4);
  assert.deepEqual(repeat.state.groups, split.state.groups);
  const done = round(repeat.state, { [players[2]]: 2, [players[1]]: 1 });
  assert.deepEqual(done.placements, [players[2], players[1], players[0], players[3]]);
  assert.equal(done.state.history.length, 4);
  assert.deepEqual(done.state.history.map(item => item.round), [1, 2, 3, 4]);
});

test('a lower three-way tie rerolls for second through fourth while first stays fixed', () => {
  const tied = round(createDice(players), { [players[0]]: 6, [players[1]]: 3, [players[2]]: 3, [players[3]]: 3 });
  const done = round(tied.state, { [players[1]]: 4, [players[2]]: 5, [players[3]]: 6 });
  assert.deepEqual(done.placements, [players[0], players[3], players[2], players[1]]);
});

test('single-winner groups eliminate all players below tied leaders', () => {
  const mode = 'single-winner';
  const tied = round(createDice(players), { [players[0]]: 6, [players[1]]: 6, [players[2]]: 4, [players[3]]: 4 }, mode);
  assert.deepEqual(eligibleDicePlayers(tied.state, mode, 4), players.slice(0, 2));
  assert.throws(() => recordDiceRoll(tied.state, players[2], 6, mode, 4), RangeError);
  const done = round(tied.state, { [players[1]]: 1, [players[0]]: 2 }, mode);
  assert.equal(done.complete, true);
  assert.equal(done.draw, false);
  assert.equal(done.winnerAccountId, players[0]);
  assert.deepEqual(done.placements, players);
  assert.deepEqual(amounts(dicePayouts(done.placements, 13, mode, done)), [52, 0, 0, 0]);
});

test('single-winner all-player ties reroll until there is one leader', () => {
  for (const count of [3, 4]) {
    const ids = players.slice(0, count);
    const mode = 'single-winner';
    const tied = round(createDice(ids), Object.fromEntries(ids.map(id => [id, 4])), mode);
    assert.equal(tied.complete, false);
    assert.equal(tied.draw, false);
    assert.equal(tied.state.round, 2);
    assert.deepEqual(eligibleDicePlayers(tied.state, mode, count), ids);
    const repeated = round(tied.state, Object.fromEntries(ids.map(id => [id, 1])), mode);
    assert.equal(repeated.state.round, 3);
    const done = round(repeated.state, Object.fromEntries(ids.map((id, index) => [id, index === 2 ? 6 : 5])), mode);
    assert.equal(done.complete, true);
    assert.equal(done.winnerAccountId, players[2]);
    assert.deepEqual(eligibleDicePlayers(done.state, mode, count), []);
  }
});

test('single-winner three-way leaders may narrow to a pair before the final roll', () => {
  const mode = 'single-winner';
  const first = round(createDice(players), { [players[0]]: 5, [players[1]]: 5, [players[2]]: 5, [players[3]]: 4 }, mode);
  const second = round(first.state, { [players[0]]: 3, [players[1]]: 2, [players[2]]: 3 }, mode);
  assert.deepEqual(eligibleDicePlayers(second.state, mode, 4), [players[0], players[2]]);
  const done = round(second.state, { [players[0]]: 1, [players[2]]: 6 }, mode);
  assert.equal(done.winnerAccountId, players[2]);
  assert.deepEqual(done.placements, [players[2], players[0], players[1], players[3]]);
});

test('four-player shared prizes floor each percentage without redistributing fractions', () => {
  assert.deepEqual(amounts(dicePayouts(players, 1, 'shared')), [1, 1, 0, 0]);
  assert.deepEqual(amounts(dicePayouts(players, 10, 'shared')), [17, 13, 9, 0]);
  assert.deepEqual(amounts(dicePayouts(players, 15, 'shared')), [26, 20, 14, 0]);
  assert.equal(total(dicePayouts(players, 10, 'shared')), 39n);
  assert.deepEqual(amounts(dicePayouts(players.slice(0, 3), 1, 'shared')), [2, 1, 0]);
});

test('large safe stakes use exact integer arithmetic for every shared prize', () => {
  const stakes = [1, 2, 7, 100001, Math.floor(Number.MAX_SAFE_INTEGER / 4) - 1, Math.floor(Number.MAX_SAFE_INTEGER / 4)];
  for (const count of [3, 4]) for (const stake of stakes) {
    const ids = players.slice(0, count);
    const payouts = dicePayouts(ids, stake, 'shared');
    const pot = BigInt(stake) * BigInt(count);
    const expected = count === 3 ? [pot * 2n / 3n, pot / 3n, 0n] : [pot * 13n / 30n, pot / 3n, pot * 7n / 30n, 0n];
    assert.deepEqual(amounts(payouts).map(BigInt), expected);
    assert.ok(payouts.every(({ amount }) => Number.isSafeInteger(amount)));
    assert.ok(total(payouts) <= pot);
    assert.ok(pot - total(payouts) < BigInt(count));
    assert.equal(total(dicePayouts(ids, stake, 'shared', { draw: true })), pot);
    assert.equal(total(dicePayouts(ids, stake, 'single-winner')), pot);
  }
});

test('every possible initial group roll preserves earned slots and awards at most the pot', () => {
  for (const mode of ['shared', 'single-winner']) for (const count of [3, 4]) {
    const ids = players.slice(0, count);
    const combinations = 6 ** count;
    for (let combination = 0; combination < combinations; combination += 1) {
      let number = combination;
      const rolls = {};
      for (const id of ids) { rolls[id] = number % 6 + 1; number = Math.floor(number / 6); }
      const initial = round(createDice(ids), rolls, mode);
      const initialGroups = initial.state.groups.map(group => [...group]);
      let done = initial;
      if (!done.complete) {
        const nextRolls = {};
        for (const group of done.state.groups) {
          group.forEach((id, index) => {
            if (eligibleDicePlayers(done.state, mode, count).includes(id)) nextRolls[id] = 6 - index;
          });
        }
        done = round(done.state, nextRolls, mode);
      }
      assert.equal(done.complete, true);
      assert.deepEqual([...done.placements].sort(), [...ids].sort());
      const positions = new Map(done.placements.map((id, index) => [id, index]));
      for (let group = 1; group < initialGroups.length; group += 1) {
        assert.ok(Math.max(...initialGroups[group - 1].map(id => positions.get(id))) <
          Math.min(...initialGroups[group].map(id => positions.get(id))));
      }
      const payouts = dicePayouts(done.placements, 7, mode, done);
      assert.ok(total(payouts) <= BigInt(7 * count));
      if (mode === 'single-winner') assert.equal(payouts.filter(item => item.amount > 0).length, 1);
      if (done.draw) assert.deepEqual(amounts(payouts), Array(count).fill(7));
    }
  }
});

test('illegal dice values, modes, counts, and payout inputs are rejected', () => {
  const state = createDice(players.slice(0, 2));
  for (const value of [0, 7, -1, 1.5, NaN, Infinity, '6', null]) {
    assert.throws(() => recordDiceRoll(state, players[0], value, 'shared', 2), RangeError);
  }
  assert.throws(() => recordDiceRoll(state, 'outsider', 4, 'shared', 2), RangeError);
  assert.throws(() => eligibleDicePlayers(state, 'unknown', 2), TypeError);
  assert.throws(() => eligibleDicePlayers(state, 'shared', 3), TypeError);
  assert.throws(() => eligibleDicePlayers(null, 'shared', 2), TypeError);
  for (const stake of [0, -1, 1.5, '2', Infinity, NaN, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => dicePayouts(players, stake, 'shared'), RangeError);
  }
  assert.throws(() => dicePayouts(players, 1, 'unknown'), TypeError);
  assert.throws(() => dicePayouts(players, 1, 'single-winner', { winnerAccountId: 'outsider' }), TypeError);
});
