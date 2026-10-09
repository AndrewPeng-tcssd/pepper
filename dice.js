const MODES = ['shared', 'single-winner'];

function validatePlayers(accountIds) {
  if (!Array.isArray(accountIds) || accountIds.length < 2 || accountIds.length > 4 ||
      accountIds.some(id => typeof id !== 'string' || !id) || new Set(accountIds).size !== accountIds.length) {
    throw new TypeError('Dice needs two to four distinct players.');
  }
  return accountIds;
}

function createDice(accountIds) {
  validatePlayers(accountIds);
  return { round: 1, groups: [[...accountIds]], rolls: {}, history: [] };
}

function validateState(state, mode, count) {
  if (!MODES.includes(mode)) throw new TypeError('Invalid dice mode.');
  if (!state || !Number.isSafeInteger(state.round) || state.round < 1 ||
      !Array.isArray(state.groups) || state.groups.some(group => !Array.isArray(group) || !group.length) ||
      !state.rolls || typeof state.rolls !== 'object' || Array.isArray(state.rolls) || !Array.isArray(state.history)) {
    throw new TypeError('Invalid dice state.');
  }
  const players = validatePlayers(state.groups.flat());
  if (count !== players.length) throw new TypeError('Invalid dice player count.');
  return players;
}

// Group order fixes the places already earned. A reroll only sorts players
// inside their tied group, so it can never move them past another group.
function eligibleDicePlayers(state, mode, count) {
  validateState(state, mode, count);
  if (state.complete) return [];
  const groups = mode === 'single-winner' && count > 2 ? [state.groups[0]] : state.groups;
  return groups.filter(group => group.length > 1).flat()
    .filter(accountId => !Object.hasOwn(state.rolls, accountId));
}

function divideGroup(group, rolls) {
  const byRoll = new Map();
  for (const accountId of group) {
    const value = rolls[accountId];
    if (!byRoll.has(value)) byRoll.set(value, []);
    byRoll.get(value).push(accountId);
  }
  return [...byRoll.entries()].sort(([a], [b]) => b - a).map(([, players]) => players);
}

function outcome(state, complete = false, draw = false) {
  const placements = complete ? state.groups.flat() : [];
  return { state, complete, draw, winnerAccountId: complete && !draw ? placements[0] : null, placements };
}

function recordDiceRoll(state, accountId, value, mode, count) {
  if (!Number.isInteger(value) || value < 1 || value > 6) throw new RangeError('Roll must be one through six.');
  if (!eligibleDicePlayers(state, mode, count).includes(accountId)) throw new RangeError('Player cannot roll now.');
  const next = {
    ...state, groups: state.groups.map(group => [...group]),
    rolls: { ...state.rolls, [accountId]: value }, history: [...state.history]
  };
  if (eligibleDicePlayers(next, mode, count).length) return outcome(next);

  next.history.push({ round: next.round, groups: next.groups.map(group => [...group]), rolls: { ...next.rolls } });
  const isFirstRound = next.round === 1;
  const everyoneTied = isFirstRound && new Set(Object.values(next.rolls)).size === 1;
  if (everyoneTied && (count === 2 || mode === 'shared')) {
    next.complete = true;
    next.draw = true;
    return outcome(next, true, true);
  }

  if (mode === 'single-winner' && count > 2) {
    next.groups = [...divideGroup(next.groups[0], next.rolls), ...next.groups.slice(1)];
  } else {
    next.groups = next.groups.flatMap(group => group.length === 1 ? [group] : divideGroup(group, next.rolls));
  }
  const complete = mode === 'single-winner' && count > 2
    ? next.groups[0].length === 1 : next.groups.every(group => group.length === 1);
  if (complete) {
    next.complete = true;
    next.draw = false;
    return outcome(next, true);
  }
  next.round += 1;
  next.rolls = {};
  return outcome(next);
}

function dicePayouts(placements, stake, mode, { draw = false, winnerAccountId = null } = {}) {
  validatePlayers(placements);
  if (!MODES.includes(mode)) throw new TypeError('Invalid dice mode.');
  if (!Number.isSafeInteger(stake) || stake < 1) throw new RangeError('Bet at least one token.');
  const count = placements.length;
  const pot = BigInt(stake) * BigInt(count);
  if (pot > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Dice pot is too large.');
  if (draw) return placements.map(accountId => ({ accountId, amount: stake }));
  if (count === 2 || mode === 'single-winner') {
    const winner = winnerAccountId ?? placements[0];
    if (!placements.includes(winner)) throw new TypeError('Invalid dice winner.');
    return placements.map(accountId => ({ accountId, amount: accountId === winner ? Number(pot) : 0 }));
  }
  const shares = count === 3 ? [2n, 1n, 0n] : [13n, 10n, 7n, 0n];
  const denominator = count === 3 ? 3n : 30n;
  // BigInt division floors each prize independently. Unclaimed fractions
  // remain unawarded rather than being reassigned to another place.
  return placements.map((accountId, index) => ({ accountId, amount: Number(pot * shares[index] / denominator) }));
}

module.exports = { createDice, eligibleDicePlayers, recordDiceRoll, dicePayouts };
