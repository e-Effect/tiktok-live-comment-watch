const LIFETIME_WEIGHTS = Object.freeze({
  coins: 45,
  visits: 25,
  comments: 20,
  recency: 10,
  likes: 5
});

export function buildContributionRankings(rows = []) {
  const prepared = rows.map((row) => ({
    userId: String(row.user_id || row.userId || ""),
    searchText: normalizeSearchText(row.search_text || row.searchText || ""),
    visits: nonNegativeNumber(row.visits),
    comments: nonNegativeNumber(row.comments),
    coins: nonNegativeNumber(row.coins),
    likes: nonNegativeNumber(row.likes),
    lastSeenAt: timestamp(row.stats_last_seen_at || row.lastSeenAt),
    recentVisits: nonNegativeNumber(row.recent_visits || row.recentVisits),
    recentComments: nonNegativeNumber(row.recent_comments || row.recentComments),
    recentCoins: nonNegativeNumber(row.recent_coins || row.recentCoins),
    recentLikes: nonNegativeNumber(row.recent_likes || row.recentLikes),
    recentLastSeenAt: timestamp(row.recent_last_seen_at || row.recentLastSeenAt)
  })).filter((row) => row.userId);

  const lifetimeEligible = prepared.filter(isLifetimeEligible);
  const recentEligible = prepared.filter(isRecentEligible);
  applyScores(lifetimeEligible, {
    visits: "visits",
    comments: "comments",
    coins: "coins",
    recency: "lastSeenAt",
    likes: "likes",
    score: "contributionScore"
  });
  applyScores(recentEligible, {
    visits: "recentVisits",
    comments: "recentComments",
    coins: "recentCoins",
    recency: "recentLastSeenAt",
    likes: "recentLikes",
    score: "recentContributionScore"
  });

  rankRows(lifetimeEligible, {
    score: "contributionScore",
    position: "contributionPosition",
    total: "contributionTotal",
    rank: "contributionRank",
    tieBreakers: ["coins", "comments", "visits", "likes", "lastSeenAt"]
  });
  rankRows(recentEligible, {
    score: "recentContributionScore",
    position: "recentContributionPosition",
    total: "recentContributionTotal",
    rank: "recentContributionRank",
    tieBreakers: ["recentCoins", "recentComments", "recentVisits", "recentLikes", "recentLastSeenAt"]
  });

  const lifetimeSet = new Set(lifetimeEligible.map((row) => row.userId));
  const recentSet = new Set(recentEligible.map((row) => row.userId));
  for (const row of prepared) {
    if (!lifetimeSet.has(row.userId)) {
      row.contributionScore = 0;
      row.contributionPosition = null;
      row.contributionTotal = lifetimeEligible.length;
      row.contributionRank = "集計不足";
    }
    if (!recentSet.has(row.userId)) {
      row.recentContributionScore = 0;
      row.recentContributionPosition = null;
      row.recentContributionTotal = recentEligible.length;
      row.recentContributionRank = "活動なし";
    }
  }

  const byUserId = new Map(prepared.map((row) => [row.userId, publicRanking(row)]));
  const lifetimeOrder = [...prepared].sort((left, right) =>
    nullablePosition(left.contributionPosition) - nullablePosition(right.contributionPosition)
      || right.lastSeenAt - left.lastSeenAt
      || left.userId.localeCompare(right.userId)
  ).map((row) => row.userId);
  const recentOrder = [...prepared].sort((left, right) =>
    nullablePosition(left.recentContributionPosition) - nullablePosition(right.recentContributionPosition)
      || nullablePosition(left.contributionPosition) - nullablePosition(right.contributionPosition)
      || right.lastSeenAt - left.lastSeenAt
      || left.userId.localeCompare(right.userId)
  ).map((row) => row.userId);

  return { byUserId, lifetimeOrder, recentOrder };
}

export function contributionTier(position, total) {
  const rank = Number(position);
  const population = Number(total);
  if (!Number.isFinite(rank) || rank < 1 || !Number.isFinite(population) || population < 1) return "集計不足";
  if (rank <= Math.max(1, Math.ceil(population * 0.03))) return "S";
  if (rank <= Math.max(1, Math.ceil(population * 0.10))) return "A";
  if (rank <= Math.max(1, Math.ceil(population * 0.25))) return "B";
  if (rank <= Math.max(1, Math.ceil(population * 0.50))) return "C";
  return "D";
}

function applyScores(rows, fields) {
  if (!rows.length) return;
  const distributions = {
    coins: cumulativeDistribution(rows, fields.coins),
    visits: cumulativeDistribution(rows, fields.visits),
    comments: cumulativeDistribution(rows, fields.comments),
    recency: cumulativeDistribution(rows, fields.recency),
    likes: cumulativeDistribution(rows, fields.likes)
  };
  for (const row of rows) {
    row[fields.score] = roundScore(
      distributions.coins.get(row.userId) * LIFETIME_WEIGHTS.coins
      + distributions.visits.get(row.userId) * LIFETIME_WEIGHTS.visits
      + distributions.comments.get(row.userId) * LIFETIME_WEIGHTS.comments
      + distributions.recency.get(row.userId) * LIFETIME_WEIGHTS.recency
      + distributions.likes.get(row.userId) * LIFETIME_WEIGHTS.likes
    );
  }
}

function cumulativeDistribution(rows, field) {
  const sorted = [...rows].sort((left, right) => left[field] - right[field]);
  const result = new Map();
  let index = 0;
  while (index < sorted.length) {
    const value = sorted[index][field];
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1][field] === value) end += 1;
    const percentile = value > 0 ? (end + 1) / sorted.length : 0;
    for (let cursor = index; cursor <= end; cursor += 1) result.set(sorted[cursor].userId, percentile);
    index = end + 1;
  }
  return result;
}

function rankRows(rows, config) {
  rows.sort((left, right) => {
    const scoreDifference = right[config.score] - left[config.score];
    if (scoreDifference) return scoreDifference;
    for (const key of config.tieBreakers) {
      const difference = right[key] - left[key];
      if (difference) return difference;
    }
    return left.userId.localeCompare(right.userId);
  });
  rows.forEach((row, index) => {
    row[config.position] = index + 1;
    row[config.total] = rows.length;
    row[config.rank] = contributionTier(index + 1, rows.length);
  });
}

function publicRanking(row) {
  return {
    userId: row.userId,
    searchText: row.searchText,
    contributionScore: row.contributionScore,
    contributionPosition: row.contributionPosition,
    contributionTotal: row.contributionTotal,
    contributionRank: row.contributionRank,
    recentContributionScore: row.recentContributionScore,
    recentContributionPosition: row.recentContributionPosition,
    recentContributionTotal: row.recentContributionTotal,
    recentContributionRank: row.recentContributionRank
  };
}

function isLifetimeEligible(row) {
  return row.coins > 0 || row.comments > 0 || row.visits >= 2 || row.likes > 0;
}

function isRecentEligible(row) {
  return row.recentCoins > 0 || row.recentComments > 0 || row.recentVisits > 0 || row.recentLikes > 0;
}

function normalizeSearchText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("ja-JP");
}

function nonNegativeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function timestamp(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullablePosition(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : Number.MAX_SAFE_INTEGER;
}

function roundScore(value) {
  return Math.round(value * 10) / 10;
}
