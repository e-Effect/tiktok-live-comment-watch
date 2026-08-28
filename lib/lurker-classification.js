export const LURKER_RULES = Object.freeze({
  minVisits: 5,
  maxCommentsPerVisit: 0.5,
  maxCoinsPerVisit: 10
});

export function classifyLurker({ visits = 0, comments = 0, coins = 0 } = {}) {
  const normalizedVisits = Math.max(0, Number(visits || 0));
  const normalizedComments = Math.max(0, Number(comments || 0));
  const normalizedCoins = Math.max(0, Number(coins || 0));
  const commentsPerVisit = normalizedVisits ? normalizedComments / normalizedVisits : 0;
  const coinsPerVisit = normalizedVisits ? normalizedCoins / normalizedVisits : 0;
  const isLurker = normalizedVisits >= LURKER_RULES.minVisits
    && commentsPerVisit < LURKER_RULES.maxCommentsPerVisit
    && coinsPerVisit < LURKER_RULES.maxCoinsPerVisit;
  const lurkerScore = normalizedVisits / (1 + normalizedComments + normalizedCoins / 10);

  return {
    isLurker,
    commentsPerVisit: roundRatio(commentsPerVisit),
    allCoinsPerVisit: roundRatio(coinsPerVisit),
    lurkerScore: roundRatio(lurkerScore)
  };
}

function roundRatio(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}
